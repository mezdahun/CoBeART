import time
import socketio  # pip install "python-socketio[client]"

SIO_URL = "http://localhost:3000"
sio = socketio.Client(reconnection=True, reconnection_attempts=0)
sio.connect(SIO_URL, transports=["websocket"], namespaces=["/ingest"])


@sio.event(namespace="/ingest")
def connect():
    print("[python] connected to /ingest")

@sio.event(namespace="/ingest")
def disconnect():
    print("[python] disconnected from /ingest")


def send_payload(payload, framerate=30):
    """
    Send a payload to the Node.js ingest server.
    :param framerate: fetching framerate in Hz, default is 30.
    :param payload: The data to send, should be a dictionary.
    """
    try:
        sio.emit("frame", payload, namespace="/ingest")
        time.sleep(1 / framerate)
        print(f"[python] sent payload: {payload}")
    except Exception as e:
        print(f"[python] error sending payload: {e}")
