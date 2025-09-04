import time
import socketio  # pip install "python-socketio[client]"
import cobeart.settings.streaming as otsettings
from cobeart.packagesender.metrics import calculate_metrics

SIO_URL = "http://localhost:3000"
sio = socketio.Client(reconnection=True, reconnection_attempts=0)
sio.connect(SIO_URL, transports=["websocket"], namespaces=["/ingest"])


@sio.event(namespace="/ingest")
def connect():
    print("[python] connected to /ingest")

@sio.event(namespace="/ingest")
def disconnect():
    print("[python] disconnected from /ingest")


class PayloadSender:
    def __init__(self, framerate=30):
        """
        Initialize the PayloadSender with a specific framerate.
        :param framerate: Fetching framerate in Hz, default is 30.
        """
        self.framerate = framerate
        self.last_sent_time = time.time()

    def send_payload(self, obj_positions):
        """
        Send a payload to the Node.js ingest server if the time interval has passed.
        :param payload: The data to send, should be a dictionary.
        """

        current_time = time.time()
        time_interval = 1 / self.framerate

        if current_time - self.last_sent_time >= time_interval:
            try:
                output_list = []
                for triplet in obj_positions:
                    id, x, y, z, roll, yaw, pitch = triplet
                    deducted_metrics = calculate_metrics(id, x, y, z, roll, yaw, pitch)
                    if id < otsettings.max_num_objects:
                        output_list.append({
                            "ID": id,
                            "x": int(x),  # [mm]
                            "y": int(y),  # [mm]
                            "z": int(z),  # [mm]
                            "roll": float(roll),  # [degrees]
                            "yaw": float(yaw),  # [degrees]
                            "pitch": float(pitch),  # [degrees]
                            "vx": float(deducted_metrics['velocity'][0]),  # [mm/s]
                            "vy": float(deducted_metrics['velocity'][1]),  # [mm/s]
                            "vz": float(deducted_metrics['velocity'][2]),  # [mm/s]
                            "vroll": float(deducted_metrics['angular_velocity'][0]),  # [degrees/s]
                            "vyaw": float(deducted_metrics['angular_velocity'][1]),  # [degrees/s]
                            "vpitch": float(deducted_metrics['angular_velocity'][2])  # [degrees/s]
                        })

                payload = {
                    "type": "optitrack",
                    "timestamp": time.time(),
                    "rigidbodies": output_list
                }

                sio.emit("frame", payload, namespace="/ingest")
                self.last_sent_time = current_time
                # print(f"[python] sent payload: {payload}")
            except Exception as e:
                print(f"[python] error sending payload: {e}")