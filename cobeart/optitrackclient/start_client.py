# Copyright © 2018 Naturalpoint
#
# Licensed under the Apache License, Version 2.0 (the "License")
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.


# OptiTrack NatNet direct depacketization sample for Python 3.x
#
# Uses the Python NatNetClient.py library to establish a connection (by creating a NatNetClient),
# and receive data via a NatNet connection and decode it using the NatNetClient library.

import sys
import time

import numpy as np
from scipy.spatial.transform import Rotation

import cobeart.settings.streaming as otsettings
from cobeart.packagesender import sender

from cobeart.optitrackclient.NatNetClient import NatNetClient
import cobeart.optitrackclient.DataDescriptions as DataDescriptions
import cobeart.optitrackclient.MoCapData as MoCapData

from scipy.spatial.transform import Rotation as R

# global variable to store and update the tracked rigid bodies
rigid_bodies = {}
payload_sender = sender.PayloadSender(framerate=otsettings.package_framerate)


def generate_output(obj_positions):
    """Generating json with positions."""
    global payload_sender
    payload_sender.send_payload(obj_positions)


# This is a callback function that gets connected to the NatNet client
# and called once per mocap frame.
def receive_new_frame(data_dict):
    global rigid_bodies
    list_to_write = [[key, *value] for key, value in rigid_bodies.items()]
    generate_output(list_to_write)


def head_tilt_from_quat(q_xyzw, axis_local):
    """
    q_xyzw: OptiTrack quaternion [x, y, z, w]
    axis_local: unit axis in the rigid body's LOCAL frame that corresponds to ear-to-ear
                e.g. np.array([1,0,0]) if local X is left-right
    returns: tilt angle in degrees (twist around axis_local), sign included
    """
    x, y, z, w = q_xyzw
    v = np.array([x, y, z], dtype=float)      # vector part
    a = axis_local / np.linalg.norm(axis_local)

    # project quaternion's vector part onto the chosen axis -> keep only rotation around that axis
    v_parallel = np.dot(v, a) * a

    # build "twist" quaternion: same w, only the component of v along a
    q_twist = np.concatenate([v_parallel, [w]])
    norm = np.linalg.norm(q_twist)
    if norm < 1e-8:
        return 0.0
    q_twist /= norm

    x_t, y_t, z_t, w_t = q_twist
    v_t = np.array([x_t, y_t, z_t])

    # angle of the twist
    angle = 2 * np.arctan2(np.linalg.norm(v_t), w_t)

    # sign according to direction along axis
    if np.dot(v_t, a) < 0:
        angle = -angle

    return np.degrees(angle)

import math
import numpy as np

def quaternion_to_rotation_matrix(q):
    x, y, z, w = q
    return [[ w*w + x*x - y*y - z*z,       2*(x*y - w*z),               2*(x*z + w*y)         ],
            [ 2*(x*y + w*z),               w*w - x*x + y*y - z*z,       2*(y*z - w*x)         ],
            [ 2*(x*z - w*y),               2*(y*z + w*x),               w*w - x*x - y*y + z*z ]]

def quaternion_to_xaxis_yaxis(q):
    x, y, z, w = q
    xaxis = [ w*w + x*x - y*y - z*z,       2*(x*y + w*z),             2*(x*z - w*y) ]
    yaxis = [ 2*(x*y - w*z),               w*w - x*x + y*y - z*z,     2*(y*z + w*x) ]
    return xaxis, yaxis

def heading_and_tilt_from_quat(q, world_up=np.array([0.0, 1.0, 0.0])):
    """
    q: OptiTrack quaternion [x, y, z, w]
    world_up: global up vector; use [0,0,1] if Z-up

    Returns:
      heading_deg: rotation around world_up (yaw)
      tilt_deg:    pure ear-to-shoulder tilt around local forward axis
    """
    # 1) Get axes in world coords
    xaxis, yaxis = quaternion_to_xaxis_yaxis(q)
    x = np.array(xaxis, dtype=float)
    y = np.array(yaxis, dtype=float)
    x /= np.linalg.norm(x)
    y /= np.linalg.norm(y)

    U = world_up / np.linalg.norm(world_up)

    # 2) Forward axis = local Z in world coords = X × Y
    z = np.cross(x, y)
    z /= np.linalg.norm(z)

    # 3) HEADING: angle of forward (or xaxis) in ground plane
    #    Here we assume Y-up world, so ground plane is XZ.
    #    If your world is Z-up, adapt accordingly.
    heading_rad = math.atan2(z[0], z[2])   # or use x[2], x[0], depending what you prefer
    heading_deg = math.degrees(heading_rad)

    # 4) TILT: rotation of head around its own forward axis, independent of yaw & nod.
    #    Plane spanned by (U, z) has normal n.
    n = np.cross(U, z)
    n_norm = np.linalg.norm(n)
    if n_norm < 1e-6:
        # forward ~ parallel to up; tilt not well-defined
        tilt_deg = 0.0
    else:
        n /= n_norm
        # y moves out of that plane only when the head tilts ear-to-shoulder
        s = float(np.clip(np.dot(y, n), -1.0, 1.0))
        tilt_rad = math.asin(s)
        tilt_deg = math.degrees(tilt_rad)

    return heading_deg, tilt_deg


# This is a callback function that gets connected to the NatNet client. It is called once per rigid body per frame
def receive_rigid_body_frame(new_id, position, rotation):
    global rigid_bodies

    # update rigid bodies global data that will be only written with every frame to the file
    if new_id < otsettings.max_num_objects:
        x = -position[0] * 1000  # rescaling to mm and conserving directional conventions with minus sign
        z = position[1] * 1000  # mm
        y = position[2] * 1000  # mm

        # transforming rotation angles from quaternion to Euler (degree)
        rot_df = [rotation[0], rotation[1], rotation[2], rotation[3]]
        rot = Rotation.from_quat([rotation[0], rotation[1], rotation[2], rotation[3]])
        rot_euler = rot.as_euler('xyz', degrees=True)
        tilt1 = Rotation.from_quat(rot_df).as_euler('xzy', degrees=True)[0]
        tilt2 = Rotation.from_quat(rot_df).as_euler('zxy', degrees=True)[0]
        tilt3 = Rotation.from_quat(rot_df).as_euler('zyx', degrees=True)[0]
        tilt4 = Rotation.from_quat(rot_df).as_euler('yzx', degrees=True)[0]
        tilt5 = Rotation.from_quat(rot_df).as_euler('yxz', degrees=True)[0]
        tilt1g = Rotation.from_quat(rot_df).as_euler('XZY', degrees=True)[0]
        tilt2g = Rotation.from_quat(rot_df).as_euler('ZXY', degrees=True)[0]
        tilt3g = Rotation.from_quat(rot_df).as_euler('ZYX', degrees=True)[0]
        tilt4g = Rotation.from_quat(rot_df).as_euler('YZX', degrees=True)[0]
        tilt5g = Rotation.from_quat(rot_df).as_euler('YXZ', degrees=True)[0]
        q = [rotation[0], rotation[1], rotation[2], rotation[3]]  # OptiTrack [x,y,z,w]
        # heading, head_tilt = heading_and_tilt_from_quat(q)
        # print(f"tilts: xzy: {tilt1:.2f}, zxy: {tilt2:.2f}, zyx: {tilt3:.2f}, yzx: {tilt4:.2f}, yxz: {tilt5:.2f}")
        # print(f"       XZY: {tilt1g:.2f}, ZXY: {tilt2g:.2f}, ZYX: {tilt3g:.2f}, YZX: {tilt4g:.2f}, YXZ: {tilt5g:.2f}")
        # print(f"heading: {heading:.2f}, head_tilt: {head_tilt:.2f}")
        # roll = rot_euler[0]
        # yaw = rot_euler[1]
        # pitch = rot_euler[2]
        # tilt_axis_local = np.array([1.0, 0.0, 0.0])
        # tilt = head_tilt_from_quat([rotation[0], rotation[1], rotation[2], rotation[3]], tilt_axis_local)

        # updating rigid body along Motive ID
        rigid_bodies[new_id] = [x, y, z, tilt1, tilt2, tilt3]
    else:
        print(f"Rigid body ID is too high: {new_id}. The maximum number of tracked rigid"
              f" bodies is {otsettings.max_num_objects}! Update settings if necessary.")




def add_lists(totals, totals_tmp):
    totals[0] += totals_tmp[0]
    totals[1] += totals_tmp[1]
    totals[2] += totals_tmp[2]
    return totals


def print_configuration(natnet_client):
    natnet_client.refresh_configuration()
    print("Connection Configuration:")
    print("  Client:          %s" % natnet_client.local_ip_address)
    print("  Server:          %s" % natnet_client.server_ip_address)
    print("  Command Port:    %d" % natnet_client.command_port)
    print("  Data Port:       %d" % natnet_client.data_port)

    if natnet_client.use_multicast:
        print("  Using Multicast")
        print("  Multicast Group: %s" % natnet_client.multicast_address)
    else:
        print("  Using Unicast")

    # NatNet Server Info
    application_name = natnet_client.get_application_name()
    nat_net_requested_version = natnet_client.get_nat_net_requested_version()
    nat_net_version_server = natnet_client.get_nat_net_version_server()
    server_version = natnet_client.get_server_version()

    print("  NatNet Server Info")
    print("    Application Name %s" % (application_name))
    print("    NatNetVersion  %d %d %d %d" % (
        nat_net_version_server[0], nat_net_version_server[1], nat_net_version_server[2], nat_net_version_server[3]))
    print(
        "    ServerVersion  %d %d %d %d" % (server_version[0], server_version[1], server_version[2], server_version[3]))
    print("  NatNet Bitstream Requested")
    print("    NatNetVersion  %d %d %d %d" % (nat_net_requested_version[0], nat_net_requested_version[1], \
                                              nat_net_requested_version[2], nat_net_requested_version[3]))
    # print("command_socket = %s"%(str(natnet_client.command_socket)))
    # print("data_socket    = %s"%(str(natnet_client.data_socket)))


def print_commands(can_change_bitstream):
    outstring = "Commands:\n"
    outstring += "Return Data from Motive\n"
    outstring += "  s  send data descriptions\n"
    outstring += "  r  resume/start frame playback\n"
    outstring += "  p  pause frame playback\n"
    outstring += "     pause may require several seconds\n"
    outstring += "     depending on the frame data size\n"
    outstring += "Change Working Range\n"
    outstring += "  o  reset Working Range to: start/current/end frame = 0/0/end of take\n"
    outstring += "  w  set Working Range to: start/current/end frame = 1/100/1500\n"
    outstring += "Return Data Display Modes\n"
    outstring += "  j  print_level = 0 supress data description and mocap frame data\n"
    outstring += "  k  print_level = 1 show data description and mocap frame data\n"
    outstring += "  l  print_level = 20 show data description and every 20th mocap frame data\n"
    outstring += "Change NatNet data stream version (Unicast only)\n"
    outstring += "  3  Request 3.1 data stream (Unicast only)\n"
    outstring += "  4  Request 4.1 data stream (Unicast only)\n"
    outstring += "t  data structures self test (no motive/server interaction)\n"
    outstring += "c  show configuration\n"
    outstring += "h  print commands\n"
    outstring += "q  quit\n"
    outstring += "\n"
    outstring += "NOTE: Motive frame playback will respond differently in\n"
    outstring += "       Endpoint, Loop, and Bounce playback modes.\n"
    outstring += "\n"
    outstring += "EXAMPLE: PacketClient [serverIP [ clientIP [ Multicast/Unicast]]]\n"
    outstring += "         PacketClient \"192.168.10.14\" \"192.168.10.14\" Multicast\n"
    outstring += "         PacketClient \"127.0.0.1\" \"127.0.0.1\" u\n"
    outstring += "\n"
    print(outstring)


def request_data_descriptions(s_client):
    # Request the model definitions
    s_client.send_request(s_client.command_socket, s_client.NAT_REQUEST_MODELDEF, "",
                          (s_client.server_ip_address, s_client.command_port))


def test_classes():
    totals = [0, 0, 0]
    print("Test Data Description Classes")
    totals_tmp = DataDescriptions.test_all()
    totals = add_lists(totals, totals_tmp)
    print("")
    print("Test MoCap Frame Classes")
    totals_tmp = MoCapData.test_all()
    totals = add_lists(totals, totals_tmp)
    print("")
    print("All Tests totals")
    print("--------------------")
    print("[PASS] Count = %3.1d" % totals[0])
    print("[FAIL] Count = %3.1d" % totals[1])
    print("[SKIP] Count = %3.1d" % totals[2])


def my_parse_args(arg_list, args_dict):
    # set up base values
    arg_list_len = len(arg_list)
    if arg_list_len > 1:
        args_dict["serverAddress"] = arg_list[1]
        if arg_list_len > 2:
            args_dict["clientAddress"] = arg_list[2]
        if arg_list_len > 3:
            if len(arg_list[3]):
                args_dict["use_multicast"] = True
                if arg_list[3][0].upper() == "U":
                    args_dict["use_multicast"] = False

    return args_dict


def start():
    """Fully from OptiTrack NatNet SDK"""
    optionsDict = {}
    optionsDict["clientAddress"] = otsettings.client_address
    optionsDict["serverAddress"] = otsettings.server_address
    optionsDict["use_multicast"] = otsettings.use_multicast

    # This will create a new NatNet client
    optionsDict = my_parse_args(sys.argv, optionsDict)

    streaming_client = NatNetClient()
    streaming_client.set_client_address(optionsDict["clientAddress"])
    streaming_client.set_server_address(optionsDict["serverAddress"])
    streaming_client.set_use_multicast(optionsDict["use_multicast"])

    # Configure the streaming client to call our rigid body handler on the emulator to send data out.
    streaming_client.new_frame_listener = receive_new_frame
    streaming_client.rigid_body_listener = receive_rigid_body_frame

    # Start up the streaming client now that the callbacks are set up.
    # This will run perpetually, and operate on a separate thread.
    is_running = streaming_client.run()
    if not is_running:
        print("ERROR: Could not start streaming client.")
        try:
            sys.exit(1)
        except SystemExit:
            print("...")
        finally:
            print("exiting")

    is_looping = True
    time.sleep(1)
    if streaming_client.connected() is False:
        print("ERROR: Could not connect properly.  Check that Motive streaming is on.")
        try:
            sys.exit(2)
        except SystemExit:
            print("...")
        finally:
            print("exiting")

    print_configuration(streaming_client)
    print("\n")
    print_commands(streaming_client.can_change_bitstream_version())

    while is_looping:
        inchars = input('Enter command or (\'h\' for list of commands)\n')
        if len(inchars) > 0:
            c1 = inchars[0].lower()
            if c1 == 'h':
                print_commands(streaming_client.can_change_bitstream_version())
            elif c1 == 'c':
                print_configuration(streaming_client)
            elif c1 == 's':
                request_data_descriptions(streaming_client)
                time.sleep(1)
            elif (c1 == '3') or (c1 == '4'):
                if streaming_client.can_change_bitstream_version():
                    tmp_major = 4
                    tmp_minor = 1
                    if (c1 == '3'):
                        tmp_major = 3
                        tmp_minor = 1
                    return_code = streaming_client.set_nat_net_version(tmp_major, tmp_minor)
                    time.sleep(1)
                    if return_code == -1:
                        print("Could not change bitstream version to %d.%d" % (tmp_major, tmp_minor))
                    else:
                        print("Bitstream version at %d.%d" % (tmp_major, tmp_minor))
                else:
                    print("Can only change bitstream in Unicast Mode")

            elif c1 == 'p':
                sz_command = "TimelineStop"
                return_code = streaming_client.send_command(sz_command)
                time.sleep(1)
                print("Command: %s - return_code: %d" % (sz_command, return_code))
            elif c1 == 'r':
                sz_command = "TimelinePlay"
                return_code = streaming_client.send_command(sz_command)
                print("Command: %s - return_code: %d" % (sz_command, return_code))
            elif c1 == 'o':
                tmpCommands = ["TimelinePlay",
                               "TimelineStop",
                               "SetPlaybackStartFrame,0",
                               "SetPlaybackStopFrame,1000000",
                               "SetPlaybackLooping,0",
                               "SetPlaybackCurrentFrame,0",
                               "TimelineStop"]
                for sz_command in tmpCommands:
                    return_code = streaming_client.send_command(sz_command)
                    print("Command: %s - return_code: %d" % (sz_command, return_code))
                time.sleep(1)
            elif c1 == 'w':
                tmp_commands = ["TimelinePlay",
                                "TimelineStop",
                                "SetPlaybackStartFrame,10",
                                "SetPlaybackStopFrame,1500",
                                "SetPlaybackLooping,0",
                                "SetPlaybackCurrentFrame,100",
                                "TimelineStop"]
                for sz_command in tmp_commands:
                    return_code = streaming_client.send_command(sz_command)
                    print("Command: %s - return_code: %d" % (sz_command, return_code))
                time.sleep(1)
            elif c1 == 't':
                test_classes()

            elif c1 == 'j':
                streaming_client.set_print_level(0)
                print("Showing only received frame numbers and supressing data descriptions")
            elif c1 == 'k':
                streaming_client.set_print_level(1)
                print("Showing every received frame")

            elif c1 == 'l':
                print_level = streaming_client.set_print_level(20)
                print_level_mod = print_level % 100
                if (print_level == 0):
                    print("Showing only received frame numbers and supressing data descriptions")
                elif (print_level == 1):
                    print("Showing every frame")
                elif (print_level_mod == 1):
                    print("Showing every %dst frame" % print_level)
                elif (print_level_mod == 2):
                    print("Showing every %dnd frame" % print_level)
                elif (print_level == 3):
                    print("Showing every %drd frame" % print_level)
                else:
                    print("Showing every %dth frame" % print_level)

            elif c1 == 'q':
                is_looping = False
                streaming_client.shutdown()
                break
            else:
                print("Error: Command %s not recognized" % c1)
            print("Ready...\n")
    print("exiting")


if __name__ == "__main__":
    start()
