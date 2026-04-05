# UCSD Recreation Court Booking Bot

A Python bot that automates court reservations on **rec.ucsd.edu** (powered by Innosoft Fusion).

## How It Works

The site uses a REST-like API that returns HTML fragments. After reverse-engineering the
`/Scripts/InnoSoftBooking.js` file, the complete booking flow is:

```
1. GET  /account/signinoptions          → extract CSRF token
2. POST /account/signin                 → authenticate (returns JSON)
3. GET  /booking/{productId}/dates      → available booking dates (HTML)
4. GET  /booking/{productId}/facilities → court list with facility IDs (HTML)
5. GET  /booking/{productId}/slots/{facilityId}/{year}/{month}/{day}
                                        → available time slots (HTML)
6. POST /booking/reserve                → book a slot (returns JSON)
7. POST /booking/delete/{participantId} → cancel a booking
```

## Quick Start

### 1. Install dependencies

```bash
uv add requests python-dotenv
# or: pip install requests python-dotenv
```

### 2. Configure credentials

```bash
cp .env.example .env
# Edit .env and fill in your UCSD Recreation username and password
```

### 3. Run

```bash
# List all available tennis slots for the first available date
uv run web_booking/booking_bot.py --list

# List slots for a specific date
uv run web_booking/booking_bot.py --sport tennis --date 2026-03-23 --list

# Book specified court at given time (--time, 7pm or 19) for one or two hours (--hour)
uv run web_booking/booking_bot.py --date 2026-03-23 --time 7pm --hours 2 --court "North 10"

# Wait-and-book mode: start polling after mid-night (every 5 seconds) until the slot opens
# (bookings open 3 days before the date)
uv run web_booking/booking_bot.py --date 2026-03-23 --time 7pm --hours 2 --court "North 10" --wait

# (Not tested) Book any available court at 10 AM
python booking_bot.py --sport tennis --date 2026-03-21 --time "10:00 AM"
```

## Sport Product IDs

These are the booking product UUIDs discovered from the `/booking` listing page:

| Sport       | Product ID                             |
|-------------|----------------------------------------|
| Tennis      | `9f19b678-58ce-4dfc-bd78-7166bde9e265` |
| Pickleball  | *(run `--list` to discover)*           |
| Racquetball | *(run `--list` to discover)*           |
| Squash      | *(run `--list` to discover)*           |

To find IDs for other sports, visit `https://rec.ucsd.edu/booking` while logged in
and note the UUID in each sport's URL.

## Tennis Courts (Facility IDs)

| Court         | Facility ID                            |
|---------------|----------------------------------------|
| Muir 1        | `8495eed8-3d1a-4172-b762-806061f8a8e8` |
| Muir 2        | `56461f32-41ea-44d6-b035-c574d17f1390` |
| Muir 3        | `4690f637-cd9c-4103-9eeb-0594baed0aaa` |
| Muir 4        | `48f89b1c-9405-4f58-bfc9-1e6287a037ce` |
| Muir 5        | `c3161d05-58d1-4ee9-a827-057271f44dfa` |
| North 6       | `6d1207df-7f4e-46b9-ad5c-80c0610207eb` |
| North 7       | `b1b2cac0-173e-499d-85bb-1d0eec088ab2` |
| North 8       | `730f0d80-37f0-4e56-b4a5-277b6f4d0c75` |
| North 9       | `b64826be-a0c0-43ee-9715-341c15d7c64f` |
| North 10      | `9fd5a3ea-0832-4619-961c-8f41117dbacc` |
| North 11      | `07276f80-28a5-4640-abfa-d990fdb5fb17` |
| North 12      | `0451583f-f7e5-48db-90f0-b8aa60ff8ae2` |
| Warren 13     | `f5b9c93f-697e-4915-bd7d-99b7f045e875` |
| Coast 14      | `fdb6a78e-5b37-4c7a-898b-b5333ff513f9` |

## Booking Rules (as of 2026)

- Bookings open **3 days** before the date
- **Limit 2 bookings per day**
- 1 guest allowed per day
- Private coaching prohibited

## Scheduling (Cron)

To automatically grab a slot the moment bookings open, schedule the bot to run
3 days before your target date. Example cron job (runs at 8:00 AM every day):

```cron
0 8 * * * cd /path/to/web_booking && python booking_bot.py \
    --sport tennis \
    --date $(date -d "+3 days" +\%Y-\%m-\%d) \
    --time "8:00" \
    --court "Muir 1" \
    --wait
```

Or use the `--wait` flag with a systemd timer / Task Scheduler.

## Using as a Library

```python
from booking_bot import UCSDBookingBot

bot = UCSDBookingBot("your@email.com", "yourpassword")
bot.login()

# List all courts and available times
bot.list_all_slots("tennis", "2026-03-21")

# Get facilities
facilities = bot.get_facilities("tennis")
# [{'id': '8495eed8-...', 'name': 'Tennis | Muir 1'}, ...]

# Get available slots for a specific court and date
slots = bot.get_slots("tennis", facilities[0]["id"], "2026-03-21")
# [{'time_display': '8:00 - 9:00 AM', 'spots_left': '1', 'apt_id': '...', ...}]

# Find a slot by time
slot = bot.find_slot_by_time(slots, "8:00")

# Book it
success = bot.reserve("tennis", facilities[0]["id"], slot, "2026-03-21")

# Cancel a booking
bot.cancel(participant_id)
```

## API Reference

### `POST /booking/reserve` payload

| Field  | Description                                      |
|--------|--------------------------------------------------|
| `bId`  | Booking product UUID (sport)                     |
| `fId`  | Facility UUID (court)                            |
| `aId`  | Appointment ID (from slot HTML `data-apt-id`)    |
| `tsId` | Timeslot ID (`data-timeslot-id`)                 |
| `tsiId`| Timeslot instance ID (`data-timeslotinstance-id`)|
| `y`    | Year (4-digit)                                   |
| `m`    | Month (1–12, no leading zero)                    |
| `d`    | Day (1–31, no leading zero)                      |
| `t`    | reCAPTCHA token (empty string if disabled)       |
| `v`    | reCAPTCHA version (0 = disabled)                 |

### Response

```json
{"Success": true}
// or
{"Success": false, "ErrorCode": 1}   // 1 = no spots left
// or
{"Success": false, "ErrorCode": 100} // 100 = reCAPTCHA required
```

## Notes

- The site uses **Innosoft Fusion** software (innosoftfusion.com). The same API
  pattern likely works on other universities using this platform.
- reCAPTCHA (`hdnIsReCaptchaEnabled`) is currently **disabled** for Tennis.
  If it gets enabled, you'll need to integrate a CAPTCHA-solving service.
- The session cookie (`.AspNet.ApplicationCookie`) is valid for the browser
  session. The bot maintains it automatically via `requests.Session`.
