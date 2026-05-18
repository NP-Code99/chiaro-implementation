from setuptools import setup, find_packages

setup(
    name="applypilot",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        "click>=8.1",
        "openai>=1.30",
        "playwright>=1.44",
        "python-dotenv>=1.0",
        "requests>=2.31",
        "cryptography>=42.0",
    ],
    entry_points={
        "console_scripts": [
            "applypilot=applypilot.cli:main",
        ],
    },
    python_requires=">=3.11",
)
