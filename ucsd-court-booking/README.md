# UCSD Court Booking App

This React Native app allows you to book courts at UCSD Recreation from your mobile device.

## Features

- Login with UCSD Recreation credentials
- Select sport (tennis, pickleball, etc.)
- Choose date, time, and number of hours
- Filter by court name
- List available slots
- Book consecutive hours

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Start the development server:
   ```
   npm start
   ```

3. Run on device/emulator:
   - For Android: `npm run android`
   - For iOS: `npm run ios`
   - For web: `npm run web`

## Usage

1. Launch the app and log in with your UCSD Recreation username and password.
2. On the booking screen:
   - Enter the sport (e.g., tennis)
   - Enter the date in YYYY-MM-DD format
   - Enter the start time (e.g., 8:00 AM)
   - Enter number of hours (default 1)
   - Optionally filter by court name (e.g., Muir 1)
3. Tap "List Available Slots" to see what's available.
4. Tap "Book Slot" to attempt booking.

## Notes

- Bookings open 3 days in advance.
- The app mimics the web interface's API.
- Credentials are stored securely on device.