# RN_APPS

This workspace contains a React Native app for booking UCSD Recreation courts, converted from a Python command-line script.
TypeScript (tsc -v): 6.0.2
Expo (npx expo -v): 55.0.21

## Structure

- `ucsd-court-booking/`: React Native (Expo) app with GUI for court booking
- `ref_python/`: Original Python command-line booking bot

## Setup Expo Development Build
1. npx expo install expo-dev-client
2. npm i -g eas-cli

## Getting Started

1. Open in dev container
2. Create a new app: `npx create-expo-app@latest -t blank ucsd-court-booking`
3. Change working dir: `cd ucsd-court-booking && npx expo install`
4. Using Expo Go: `npx expo start`
5. EAS build: eas login / eas init / eas build:configure
6. EAS build (Android): eas build --platform android --profile preview
7. Run on device/emulator

## Original Python Script

See `ref/README.md` for details on the command-line version.