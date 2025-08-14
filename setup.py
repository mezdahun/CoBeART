from distutils.core import setup

from setuptools import find_packages

setup(
    name='CoBeArt',
    description='Audio-visual demonstrator using spatial augmented reality, real-time body tracking and rendering',
    version='1.0',
    url='https://github.com/mezdahun/CoBeART',
    maintainer='David Mezey & David James',
    packages=find_packages(exclude=['tests']),
    package_data={'cobeart': ['*.txt']},
    python_requires=">=3.6",
    install_requires=[
        'msgpack',
        'numpy'
    ],
    extras_require={
        'test': [
            'bandit',
            'flake8',
            'pytest',
            'pytest-cov'
        ],
        'cobeart-master': [
            'opencv-python==4.7.0.72',
            'matplotlib',
            'scipy',
            'pynput',
            'psutil',
            'fabric',
            'tinyflux',
            'filterpy'
        ]
    },
    entry_points={
        'console_scripts': ["start-optitrack-client=cobeart.optitrackclient.start_client:start"           # Start Optitrack Streaming
                            ]
    },
    test_suite='tests',
    zip_safe=False
)
