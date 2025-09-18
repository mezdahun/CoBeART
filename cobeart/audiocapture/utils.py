import soundcard as sc
import os


def get_socketio_url() -> str:
    """Return Socket.IO base URL from env or default to local Electron.

    Examples:
        http://127.0.0.1:3000
    """
    return os.getenv("COBEART_SOCKETIO_URL", "http://127.0.0.1:3000")

def select_audio_device():
    """
    Lists all available microphones, including loopback devices,
    and prompts the user to select one.

    Returns:
        soundcard.Microphone: The selected microphone object.
    """
    print("--- Searching for Audio Input Devices ---")
    microphones = sc.all_microphones(include_loopback=True)
    if not microphones:
        print("No microphones found (including loopbacks). Exiting.")
        exit()

    print("--- Please Select an Audio Device ---")
    for i, mic in enumerate(microphones):
        print(f"Index {i}: {mic.name}")
    print("---------------------------------------")

    mic_index = None
    while mic_index is None:
        try:
            raw_index = input("Enter the index of the device you want to use: ")
            candidate_index = int(raw_index)
            if 0 <= candidate_index < len(microphones):
                mic_index = candidate_index
            else:
                print("Invalid index. Please choose from the list above.")
        except ValueError:
            print("Invalid input. Please enter a number.")
        except (KeyboardInterrupt, EOFError):
            print("\nSelection cancelled. Exiting.")
            exit()

    selected_mic = microphones[mic_index]
    print(f"--> Using device: {selected_mic.name}\n")
    return selected_mic
