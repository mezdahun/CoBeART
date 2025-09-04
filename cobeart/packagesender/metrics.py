import numpy as np
import time

body_history = {}
body_template = {
    'id': -1,
    'position': np.array([0.0, 0.0, 0.0]),
    'orientation': np.array([0.0, 0.0, 0.0]),  # Euler angles (roll, pitch, yaw)
    'velocity': np.array([0.0, 0.0, 0.0]),
    'angular_velocity': np.array([0.0, 0.0, 0.0]),
    'timestamp': 0.0
}


def clac_vel_from_euler_components(vx, vy):
    """Calculates overall absolute velocity from x and y vector components"""
    return np.linalg.norm([vx, vy])


def normalize_abs_velocity(abs_vel, max_vel=6000):
    """Normalizes absolute velocity to a 0-1 range based on a maximum expected velocity"""
    return min(abs_vel / max_vel, 1.0)


def calculate_metrics(id, x, y, z, roll, yaw, pitch):
    global body_history
    current_time = time.time()
    position = np.array([x, y, z])
    orientation = np.array([roll, pitch, yaw])

    # New so far non-tracked body, so we just add it to the history and return zeros for velocities
    if id not in body_history:
        body_history[id] = body_template.copy()
        body_history[id]['id'] = id
        body_history[id]['position'] = position
        body_history[id]['orientation'] = orientation
        body_history[id]['timestamp'] = current_time
        body_history[id]['velocity'] = np.array([0.0, 0.0, 0.0])
        body_history[id]['angular_velocity'] = np.array([0.0, 0.0, 0.0])
        body_history[id]['abs_velocity'] = 0.0
        body_history[id]['norm_abs_velocity'] = 0.0
        return body_history[id]

    # Existing body, calculate velocities according to time difference
    last_entry = body_history[id]
    time_diff = current_time - last_entry['timestamp']

    if time_diff > 0:
        velocity = (position - last_entry['position']) / time_diff
        angular_velocity = (orientation - last_entry['orientation']) / time_diff
    else:
        velocity = np.array([0.0, 0.0, 0.0])
        angular_velocity = np.array([0.0, 0.0, 0.0])

    body_history[id]['position'] = position
    body_history[id]['orientation'] = orientation
    body_history[id]['velocity'] = velocity
    body_history[id]['angular_velocity'] = angular_velocity
    body_history[id]['timestamp'] = current_time
    body_history[id]['abs_velocity'] = clac_vel_from_euler_components(velocity[0], velocity[1])
    body_history[id]['norm_abs_velocity'] = normalize_abs_velocity(body_history[id]['abs_velocity'])
    print(f"DEBUG metrics for ID {id}: {body_history[id]}")
    return body_history[id]
