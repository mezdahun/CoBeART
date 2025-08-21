# CoBeART
Audio-visual Art Project Using Spatial Augmented Reality

# Installation (Windows)
## Installing js application related dependencies
1.) Download and install Node.js with npm from https://nodejs.org/en/download/
2.) cd to the project application directory (CobeART/cobeart-app/)
3.) Run `npm install` to install the required packages

## Installing Python/OptiTrack related dependencies
1.) Download and install Python 3.8 or higher from https://www.python.org/downloads/
2.) Download and install OptiTrack SDK from https://v22.optitrack.com/downloads/
3.) Install the required Python packages by running `pip install -e .` in the python bridge directory (CobeART/cobeart)

# Running the Application
1.) Start the OptiTrack Motive software and ensure that the cameras are streaming data.
2.) Start the Python bridge by running `start-optitrack-client` 
3.) Start the js application by running `npm start` in the cobeart-app directory.