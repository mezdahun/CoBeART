"""This file includes the main settings that are required to transfer 3D tracking data from the OptiTrack system
to the rendering system"""

# maximum absolute coordinates (in mm) according to arena size {X, Y, Z}
max_abs_coord_x = (-3000, 3000)
max_abs_coord_y = (-3000, 3000)
max_abs_coord_z = (0, 2500)

# number of maximum rigid bodies tracked
max_num_objects = 6

# optitrack related settings
client_address = '192.168.0.104'  # the address of the CoBe computer
server_address = '192.168.0.105'  # the address of the Optitrack computer

# coordinate rescaling for arena size (arena length in meters)
# to set the ground plane and axes in optitrack put the range in the middle, the longer edge facing
# to the near projector the shorter to the right, aligned with the middle axis of the arena
x_rescale = 3.5
y_rescale = 3.5

# optitrack related settings
# decide if we use optitrack client for calculating agent coordinates, etc.
use_optitrack_client = True

# decide if we use multicast for optitrack data
use_multicast = True

# tracking framerate in Hz
tracking_framerate = 240  # the framerate at which tracking data is received from OptiTrack

# framerate at which packages are sent, should be slightly higher than tracking framrate
package_framerate = 240  # the framerate at which packages are sent to the rendering system
