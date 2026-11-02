# .frontal-code

Project-local configuration directory for fcx.

## Overview

This directory contains project-specific fcx configuration, including settings, skills, and local state. It's the project-local equivalent of the global `~/.config/frontal-code/` or similar configuration locations.

## Contents

- Configuration files for project-specific policies and permissions
- Project-local skills (v1: conventions text only)
- Local state and caches

## Usage

This directory is created by `fcx init` and is respected by fcx when running in the project. Settings in `.frontal-code/` take precedence over global settings but are subject to trust policies.

## License

Apache-2.0
