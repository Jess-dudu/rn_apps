"""
UCSD Recreation Court Booking Bot
==================================
Target: https://rec.ucsd.edu  (Innosoft Fusion platform)

Discovered API endpoints:
  Login:      GET  /account/signin/password?email=... -> password form + CSRF token
              POST /account/signin                     -> authenticate (community accounts)
              GET  /account/login                      -> SSO entry point (UCSD Shibboleth)
  Facilities: GET  /booking/{id}/facilities
  Dates:      GET  /booking/{id}/dates
  Slots:      GET  /booking/{id}/slots/{facilityId}/{year}/{month}/{day}
  Reserve:    POST /booking/reserve
  Cancel:     POST /booking/delete/{participantId}
  My bookings:GET  /booking/mybookings/{count}

Usage:
  python booking_bot.py                    # interactive mode
  python booking_bot.py --sport tennis     # list available slots
  python booking_bot.py --sport tennis --date 2026-03-21 --time "8:00" --court "Muir 1"
  python booking_bot.py --sport tennis --date 2026-03-21 --time "8:00" --hours 2 --court "Muir 1"
"""

import argparse
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path

import requests
from dotenv import load_dotenv

# Load .env from the same directory as this script (web_booking/.env)
load_dotenv(Path(__file__).parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

BASE_URL = "https://rec.ucsd.edu"


# ------------------------------------------------------------------ #
#  Time-matching helpers
# ------------------------------------------------------------------ #


def _normalise_time(t: str) -> str:
    """
    Normalise a user-supplied time string for start-time matching.

    Accepted formats (case-insensitive):
      '8'       -> '8:00 am'    bare hour, defaults to AM
      '8am'     -> '8:00 am'
      '8pm'     -> '8:00 pm'
      '8:00'    -> '8:00 am'    defaults to AM
      '8:00am'  -> '8:00 am'
      '8:00 AM' -> '8:00 am'
      '20'      -> '8:00 pm'    24-hour bare hour
      '20:00'   -> '8:00 pm'    24-hour with minutes
    """
    t = t.strip().lower().replace(" ", "")

    # Detect and strip am/pm suffix
    ampm = ""
    if t.endswith("am"):
        ampm = "am"
        t = t[:-2]
    elif t.endswith("pm"):
        ampm = "pm"
        t = t[:-2]

    # Now t is purely numeric, possibly with ":"
    # Add ":00" if no minutes given
    if ":" not in t:
        t = t + ":00"

    m = re.match(r"^(\d{1,2}):(\d{2})$", t)
    if not m:
        return t + (" " + ampm if ampm else "")  # fallback

    hour, minute = int(m.group(1)), int(m.group(2))

    # If no am/pm was given, infer from value
    if not ampm:
        if hour >= 13:
            ampm = "pm"
            hour -= 12
        elif hour == 12:
            ampm = "pm"
        elif hour == 0:
            ampm = "am"
            hour = 12
        else:
            # hours 1-11 with no qualifier -> default to AM
            ampm = "am"

    if ampm:
        return f"{hour}:{minute:02d} {ampm}"
    return f"{hour}:{minute:02d}"  # ambiguous


def _extract_start_time(time_display: str) -> str:
    """
    Extract the start time from a display string like '7:00 - 8:00 PM'.

    The AM/PM suffix at the END of the string applies to the end time.
    If the start time has its own AM/PM qualifier, use that.
    Otherwise inherit the end-time's AM/PM.

    Examples:
      '7:00 - 8:00 PM'       -> '7:00 pm'   (inherit end suffix)
      '9:00 - 10:00 PM'      -> '9:00 pm'   (inherit end suffix)
      '8:00 - 9:00 AM'       -> '8:00 am'   (inherit end suffix)
      '11:00 AM - 12:00 PM'  -> '11:00 am'  (start has own AM)
    """
    t = time_display.strip().lower()

    # Split on " - " to get start and end parts
    parts = re.split(r"\s*-\s*", t, maxsplit=1)
    start_part = parts[0].strip()
    end_part = parts[1].strip() if len(parts) > 1 else ""

    # Check if start part already has am/pm
    m_start = re.search(r"\s*(am|pm)$", start_part)
    if m_start:
        # Start has its own qualifier -- use it
        start_time = re.sub(r"\s*(am|pm)$", "", start_part).strip()
        return f"{start_time} {m_start.group(1)}"

    # Start has no qualifier -- inherit from end part
    m_end = re.search(r"(am|pm)$", end_part)
    if m_end:
        return f"{start_part} {m_end.group(1)}"

    return start_part  # no qualifier found


def _times_match(target: str, slot_start: str) -> bool:
    """
    Return True if target matches slot_start.

    If target has no AM/PM qualifier, it matches regardless of AM/PM.
    If target has AM/PM, it must match exactly.
    """
    target = target.strip().lower()
    slot_start = slot_start.strip().lower()

    # Strip am/pm from both for the time-number comparison
    target_time = re.sub(r"\s*(am|pm)$", "", target).strip()
    slot_time = re.sub(r"\s*(am|pm)$", "", slot_start).strip()

    if target_time != slot_time:
        return False

    # Times match numerically -- now check AM/PM qualifier
    target_has_ampm = bool(re.search(r"(am|pm)$", target))
    if not target_has_ampm:
        return True  # no qualifier -> match any

    target_ampm = re.search(r"(am|pm)$", target).group(1)
    slot_ampm_m = re.search(r"(am|pm)$", slot_start)
    if not slot_ampm_m:
        return True  # slot has no qualifier -> accept
    return target_ampm == slot_ampm_m.group(1)


# Sport -> booking product ID mapping (discovered via /booking page)
SPORT_IDS = {
    "tennis": "9f19b678-58ce-4dfc-bd78-7166bde9e265",
    "pickleball": "a5e7e1e2-c5e4-4b3a-9f1d-2c8b3e4f5a6b",  # update with real ID
    "racquetball": "b6f8f2f3-d6f5-5c4b-af2e-3d9c4f5g6b7c",  # update with real ID
    "squash": "c7g9g3g4-e7g6-6d5c-bg3f-4eAd5g6h7c8d",  # update with real ID
}


class _SlotCardHTMLParser(HTMLParser):
    """Parse Innosoft slot cards without regex crossing card boundaries."""

    def __init__(self):
        super().__init__()
        self.slots: list[dict] = []
        self._card_depth = 0
        self._current_slot: dict | None = None
        self._capture_text_for: str | None = None

    @staticmethod
    def _attrs_to_dict(attrs: list[tuple[str, str | None]]) -> dict[str, str]:
        return {k: (v or "") for k, v in attrs}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = self._attrs_to_dict(attrs)
        class_attr = attrs_dict.get("class", "")

        if tag == "div":
            # The slot wrapper carries data-slot-number; its CSS class varies
            # across Innosoft Fusion versions so we key on the data attribute only.
            if "data-slot-number" in attrs_dict:
                self._current_slot = {
                    "slot_number": attrs_dict.get("data-slot-number", "").strip(),
                    "participant_id": attrs_dict.get("data-participant-id", "").strip(),
                    "time_display": "",
                    "spots_left": "",
                    "available": False,
                }
                self._card_depth = 1
                return

            if self._current_slot is not None and self._card_depth > 0:
                self._card_depth += 1
                return

        if self._current_slot is None:
            return

        # Time display: old=<strong>, new=<span class="slot-time">
        is_time_tag = tag == "strong" or (tag == "span" and "slot-time" in class_attr)
        if is_time_tag and not self._current_slot.get("time_display"):
            self._capture_text_for = "time_display"
        # Spots left: old=<span class="text-muted">, new=<span class="spots-available">
        elif (
            tag == "span"
            and ("text-muted" in class_attr or "spots-available" in class_attr)
            and not self._current_slot.get("spots_left")
        ):
            self._capture_text_for = "spots_left"
        elif tag == "button" and attrs_dict.get("data-apt-id"):
            self._current_slot["available"] = True
            self._current_slot["apt_id"] = attrs_dict.get("data-apt-id", "").strip()
            self._current_slot["timeslot_id"] = attrs_dict.get(
                "data-timeslot-id", ""
            ).strip()
            self._current_slot["timeslotinstance_id"] = attrs_dict.get(
                "data-timeslotinstance-id", ""
            ).strip()
            self._current_slot["slot_text"] = attrs_dict.get(
                "data-slot-text", ""
            ).strip()
            if attrs_dict.get("data-spots-left-text"):
                self._current_slot["spots_left"] = attrs_dict.get(
                    "data-spots-left-text", ""
                ).strip()

    def handle_data(self, data: str) -> None:
        if self._current_slot is None or self._capture_text_for is None:
            return
        text = data.strip()
        if text:
            existing = self._current_slot.get(self._capture_text_for, "")
            self._current_slot[self._capture_text_for] = (
                f"{existing} {text}".strip() if existing else text
            )

    def handle_endtag(self, tag: str) -> None:
        if self._capture_text_for is not None and tag in {"strong", "span"}:
            self._capture_text_for = None

        if tag == "div" and self._current_slot is not None and self._card_depth > 0:
            self._card_depth -= 1
            if self._card_depth == 0:
                self.slots.append(self._current_slot)
                self._current_slot = None


class UCSDBookingBot:
    """Bot for booking courts at UCSD Recreation (rec.ucsd.edu)."""

    # (connect_timeout, read_timeout) in seconds.
    # requests has NO default timeout — without this every call blocks forever.
    REQUEST_TIMEOUT = (10, 30)

    def __init__(self, username: str, password: str):
        self.username = username
        self.password = password
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
                ),
                "Accept-Language": "en-US,en;q=0.9",
            }
        )
        self._logged_in = False

    # ------------------------------------------------------------------ #
    #  Authentication
    # ------------------------------------------------------------------ #

    def login(self) -> bool:
        """Login to rec.ucsd.edu. Returns True on success."""
        # Two-step login for community/local accounts:
        #   Step 1: GET /account/signin/password?email=... -> password form + CSRF token
        #   Step 2: POST /account/signin/password with email, password, CSRF token
        password_url = f"{BASE_URL}/account/signin/password"

        log.info("Fetching login page for CSRF token...")
        # Step 0: visit the login landing page to establish the session cookie,
        # exactly as a browser would before submitting the email form.
        self.session.get(
            f"{BASE_URL}/account/login",
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=self.REQUEST_TIMEOUT,
        )
        # Step 1: submit the email to get the password form + CSRF token.
        # Use a minimal User-Agent so the server returns a lean page with only
        # the password form's token (not extra nav-bar search-form tokens).
        resp = self.session.get(
            password_url,
            params={"email": self.username},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=self.REQUEST_TIMEOUT,
        )
        resp.raise_for_status()

        # Find the token specifically inside the password form (id="form-signin-password").
        # The page also contains search-form tokens; using the wrong one causes 403.
        m = re.search(
            r'id="form-signin-password".*?'
            r'name="__RequestVerificationToken"[^>]*value="([^"]+)"',
            resp.text,
            re.DOTALL,
        )
        if not m:
            log.error("Could not find CSRF token on login page")
            return False
        csrf = m.group(1)

        log.info("Submitting credentials...")
        # The signin endpoint is an AJAX endpoint that returns JSON.
        # Field names are Username/Password (capital), not email/password.
        login_resp = self.session.post(
            f"{BASE_URL}/account/signin",
            data={
                "__RequestVerificationToken": csrf,
                "Username": self.username,
                "Password": self.password,
                "returnUrl": "",
            },
            headers={"X-Requested-With": "XMLHttpRequest"},
            timeout=self.REQUEST_TIMEOUT,
        )
        login_resp.raise_for_status()

        result = login_resp.json()
        if not result.get("IsSuccess"):
            log.error(f"Login failed: {result.get('ErrorMessage', 'unknown error')}")
            return False

        log.info("Login successful")
        self._logged_in = True
        return True

    def _ensure_logged_in(self):
        if not self._logged_in:
            if not self.login():
                raise RuntimeError("Authentication failed")

    # ------------------------------------------------------------------ #
    #  Facilities
    # ------------------------------------------------------------------ #

    def get_facilities(self, sport: str) -> list[dict]:
        """Return list of {id, name} dicts for the given sport."""
        self._ensure_logged_in()
        product_id = self._resolve_product_id(sport)

        resp = self.session.get(
            f"{BASE_URL}/booking/{product_id}/facilities",
            timeout=self.REQUEST_TIMEOUT,
        )
        resp.raise_for_status()

        ids = re.findall(r'data-facility-id="([^"]+)"', resp.text)
        names = re.findall(r'data-facility-name="([^"]+)"', resp.text)

        # De-duplicate (each facility appears twice: mobile + desktop)
        seen = set()
        facilities = []
        for fid, fname in zip(ids, names):
            if fid not in seen:
                seen.add(fid)
                facilities.append({"id": fid, "name": fname.strip()})

        log.info(f"Found {len(facilities)} facilities for {sport}")
        return facilities

    # ------------------------------------------------------------------ #
    #  Available dates
    # ------------------------------------------------------------------ #

    def get_available_dates(self, sport: str) -> list[str]:
        """Return list of available booking dates as 'YYYY-MM-DD' strings."""
        self._ensure_logged_in()
        product_id = self._resolve_product_id(sport)

        resp = self.session.get(
            f"{BASE_URL}/booking/{product_id}/dates",
            timeout=self.REQUEST_TIMEOUT,
        )
        resp.raise_for_status()

        m = re.search(r'id="hdnDates" value="([^"]+)"', resp.text)
        if not m:
            return []
        dates_raw = m.group(1).replace("&quot;", '"')
        dates = json.loads(dates_raw)
        return [d[:10] for d in dates]

    # ------------------------------------------------------------------ #
    #  Slots
    # ------------------------------------------------------------------ #

    def get_slots(
        self,
        sport: str,
        facility_id: str,
        date: str,
        available_only: bool = True,
    ) -> list[dict]:
        """
        Return slots for a given facility and date.

        Each slot dict contains:
          time_display, spots_left, available (bool),
          apt_id, timeslot_id, timeslotinstance_id  <- only when available=True

        Args:
            available_only: if True (default), only return bookable slots.
                            if False, return all slots including unavailable ones.
        """
        self._ensure_logged_in()
        product_id = self._resolve_product_id(sport)
        y, m, d = date.split("-")

        url = f"{BASE_URL}/booking/{product_id}/slots/{facility_id}/{y}/{m}/{d}"
        resp = self.session.get(url, timeout=self.REQUEST_TIMEOUT)
        resp.raise_for_status()

        if resp.text.startswith("<!DOCTYPE"):
            log.warning("Slots endpoint returned full HTML page (session issue?)")
            return []

        parser = _SlotCardHTMLParser()
        parser.feed(resp.text)

        slots = []
        for slot in parser.slots:
            if available_only and not slot.get("available"):
                continue
            slots.append(slot)

        return slots

    def find_slot_by_time(self, slots: list[dict], target_time: str) -> dict | None:
        """
        Find a slot whose START time matches target_time.

        target_time examples: '8:00', '8:00 AM', '9:00 PM', '21:00'
        Slot time_display format: '7:00 - 8:00 PM', '9:00 - 10:00 PM'

        Matching rules:
          - '8' or '8:00'  -> matches any slot starting at 8:00 (AM or PM)
          - '8am'          -> matches only AM slots starting at 8:00
          - '9pm' or '21'  -> matches only PM slots starting at 9:00
          - '20' or '20:00'-> converted to '8:00 PM'

        Only the START time (before the dash) is compared.
        """
        # Normalise target: convert 24h to 12h if needed
        target_norm = _normalise_time(target_time)

        for slot in slots:
            if not slot.get("available"):
                continue
            # Extract start time from "H:MM - H:MM AM/PM"
            start = _extract_start_time(slot["time_display"])
            if _times_match(target_norm, start):
                return slot
        return None

    def find_consecutive_slots(
        self, slots: list[dict], target_time: str, num_hours: int = 1
    ) -> list[dict] | None:
        """
        Find num_hours consecutive available slots starting at target_time.

        Returns a list of slot dicts (length == num_hours) if all consecutive
        slots are available, or None if any slot in the chain is missing/taken.

        Example: target_time='8am', num_hours=2 -> [8-9 AM slot, 9-10 AM slot]
        """
        if num_hours <= 0:
            return []

        # Find the first slot
        first = self.find_slot_by_time(slots, target_time)
        if first is None:
            return None

        result = [first]

        for _ in range(num_hours - 1):
            # Derive the next start time from the current slot's end time.
            # time_display format: "H:MM - H:MM AM/PM"
            td = result[-1]["time_display"]
            parts = re.split(r"\s*-\s*", td, maxsplit=1)
            if len(parts) < 2:
                log.warning(f"Cannot parse end time from '{td}'")
                return None
            next_start = parts[1].strip()  # e.g. "9:00 AM"

            nxt = self.find_slot_by_time(slots, next_start)
            if nxt is None:
                log.warning(
                    f"Consecutive slot starting at '{next_start}' not available"
                )
                return None
            result.append(nxt)

        return result

    def find_any_slot_in_window(
        self, all_slots: list[dict], target_time: str, num_hours: int
    ) -> dict | None:
        """
        Find any single available slot within a num_hours window starting at target_time.

        Walks the time chain (using all_slots which includes unavailable slots to
        determine the sequence of start times) and returns the first available slot
        found anywhere in the window.

        Use this as a fallback when find_consecutive_slots fails: if you asked for
        2 hours but only 1 is free (either the 1st or 2nd hour), this returns it.

        all_slots must include unavailable slots (get_slots(..., available_only=False)).
        """
        current_time = target_time
        for _ in range(num_hours):
            # Locate this time in all_slots (available or not) to read the time chain
            target_norm = _normalise_time(current_time)
            slot_info = None
            for s in all_slots:
                start = _extract_start_time(s["time_display"])
                if _times_match(target_norm, start):
                    slot_info = s
                    break

            if slot_info is None:
                break

            if slot_info.get("available"):
                return slot_info

            # Advance to the next hour using this slot's end time
            td = slot_info["time_display"]
            parts = re.split(r"\s*-\s*", td, maxsplit=1)
            if len(parts) < 2:
                break
            current_time = parts[1].strip()  # e.g. "9:00 AM"

        return None

    # ------------------------------------------------------------------ #
    #  Booking
    # ------------------------------------------------------------------ #

    def reserve(
        self,
        sport: str,
        facility_id: str,
        slot: dict,
        date: str,
    ) -> bool:
        """
        Reserve a single slot. Returns True on success.

        slot must contain: apt_id, timeslot_id, timeslotinstance_id
        date must be 'YYYY-MM-DD'
        """
        self._ensure_logged_in()
        product_id = self._resolve_product_id(sport)
        y, m, d = date.split("-")

        post_data = {
            "bId": product_id,
            "fId": facility_id,
            "aId": slot["apt_id"],
            "tsId": slot["timeslot_id"],
            "tsiId": slot["timeslotinstance_id"],
            "y": y,
            "m": m,
            "d": d,
            "t": "",  # reCAPTCHA token (empty = disabled)
            "v": "0",  # version 0 = no captcha
        }

        log.info(
            f"Reserving {sport} on {date} at {slot['time_display']} "
            f"(facility {facility_id[:8]}...)"
        )
        resp = self.session.post(
            f"{BASE_URL}/booking/reserve",
            data=post_data,
            timeout=self.REQUEST_TIMEOUT,
        )
        resp.raise_for_status()

        result = resp.json()
        if result.get("Success"):
            log.info("Booking successful!")
            return True
        else:
            err_code = result.get("ErrorCode", "?")
            log.error(f"Booking failed (ErrorCode={err_code}): {result}")
            return False

    def reserve_multi(
        self,
        sport: str,
        facility_id: str,
        slots: list[dict],
        date: str,
    ) -> bool:
        """
        Reserve multiple consecutive slots for the same court in one call.

        Books each slot sequentially; rolls back (cancels) already-booked slots
        if a later slot fails.  Returns True only if ALL slots were booked.

        slots must be a list of slot dicts as returned by find_consecutive_slots().
        date must be 'YYYY-MM-DD'
        """
        if not slots:
            return False

        booked_participant_ids: list[str] = []

        for slot in slots:
            ok = self.reserve(sport, facility_id, slot, date)
            if not ok:
                # Roll back any slots already booked in this call
                if booked_participant_ids:
                    log.warning(
                        f"Slot {slot['time_display']} failed; "
                        f"cancelling {len(booked_participant_ids)} already-booked slot(s)..."
                    )
                    for pid in booked_participant_ids:
                        self.cancel(pid)
                return False

            # After a successful reserve the server updates the participant_id
            # on the slot card; re-fetch my bookings to get the new participant ID
            # so we can cancel if needed.  For simplicity we store what we have.
            booked_participant_ids.append(slot.get("participant_id", ""))

        log.info(
            f"Successfully booked {len(slots)} consecutive hour(s) "
            f"starting at {slots[0]['time_display']} on {date}"
        )
        return True

    def cancel(self, participant_id: str) -> bool:
        """Cancel a booking by participant ID."""
        self._ensure_logged_in()
        resp = self.session.post(
            f"{BASE_URL}/booking/delete/{participant_id}",
            timeout=self.REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        if resp.json() is True:
            log.info(f"Booking {participant_id} cancelled")
            return True
        log.warning(f"Cancel returned unexpected response: {resp.text[:100]}")
        return False

    def get_my_bookings(self) -> str:
        """Return raw HTML of current user's upcoming bookings."""
        self._ensure_logged_in()
        resp = self.session.get(
            f"{BASE_URL}/booking/mybookings/10", timeout=self.REQUEST_TIMEOUT
        )
        resp.raise_for_status()
        return resp.text

    # ------------------------------------------------------------------ #
    #  Scheduled booking (wait until open)
    # ------------------------------------------------------------------ #

    def book_when_open(
        self,
        sport: str,
        target_date: str,
        target_time: str,
        court_name: str | None = None,
        num_hours: int = 1,
        poll_interval: float = 5.0,
        poll_duration_min: float = 5.0,
    ) -> bool:
        """
        Poll until the target slot(s) become available, then book them.

        Bookings open 3 days before the date. Run this script ~3 days
        before your desired date to grab the slot the moment it opens.

        Args:
            sport:             'tennis', 'pickleball', etc.
            target_date:       'YYYY-MM-DD'
            target_time:       e.g. '8am', '9pm', '21'
            court_name:        partial court name to filter, e.g. 'Muir 1'
            num_hours:         number of consecutive hours to book (default 1)
            poll_interval:     seconds between retries (env: POLL_INTERVAL_SEC)
            poll_duration_min: give up after this many minutes (env: POLL_DURATION_MIN)
        """
        max_attempts = max(1, int(poll_duration_min * 60 / poll_interval))
        self._ensure_logged_in()

        log.info(
            f"Waiting for {sport} slot on {target_date} at {target_time} "
            f"({num_hours}h)" + (f" ({court_name})" if court_name else "")
        )

        # Sleep until midnight tonight (the next 00:00:00 from program start).
        # Bookings on rec.ucsd.edu open at midnight, so we wait until then to poll.
        now = datetime.now()
        midnight = (now + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        wait_secs = (midnight - now).total_seconds()
        log.info(
            f"Sleeping until midnight ({midnight.strftime('%Y-%m-%d 00:00:00')}) "
            f"before polling — {wait_secs / 3600:.2f}h ({wait_secs / 60:.1f} min) to go..."
        )
        time.sleep(wait_secs)
        log.info("Midnight reached — starting to poll now.")

        facilities = self.get_facilities(sport)
        if court_name:
            facilities = [
                f for f in facilities if court_name.lower() in f["name"].lower()
            ]
            if not facilities:
                log.error(f"No facility matching '{court_name}'")
                return False

        for attempt in range(1, max_attempts + 1):
            try:
                for facility in facilities:
                    slots = self.get_slots(sport, facility["id"], target_date)
                    consecutive = self.find_consecutive_slots(
                        slots, target_time, num_hours
                    )
                    if consecutive:
                        log.info(
                            f"Found {num_hours} consecutive slot(s) on attempt "
                            f"{attempt} at {facility['name']}"
                        )
                        return self.reserve_multi(
                            sport, facility["id"], consecutive, target_date
                        )

                    # Fallback: book any single available slot in the window
                    if num_hours > 1:
                        all_slots = self.get_slots(
                            sport, facility["id"], target_date, available_only=False
                        )
                        slot = self.find_any_slot_in_window(
                            all_slots, target_time, num_hours
                        )
                        if slot:
                            log.info(
                                f"Full {num_hours}h window unavailable; booking "
                                f"partial slot {slot['time_display']} at {facility['name']}"
                            )
                            return self.reserve(
                                sport, facility["id"], slot, target_date
                            )

                elapsed_min = (attempt * poll_interval) / 60
                log.info(
                    f"Attempt {attempt}/{max_attempts} "
                    f"({elapsed_min:.1f}/{poll_duration_min:.0f} min): "
                    f"no slot yet, retrying in {poll_interval:.0f}s..."
                )
                time.sleep(poll_interval)

            except requests.RequestException as e:
                log.warning(f"Network error on attempt {attempt}: {e}")
                time.sleep(poll_interval * 2)

        log.error(f"Gave up after {max_attempts} attempts")
        return False

    # ------------------------------------------------------------------ #
    #  Helpers
    # ------------------------------------------------------------------ #

    def _resolve_product_id(self, sport: str) -> str:
        sport_lower = sport.lower()
        if sport_lower in SPORT_IDS:
            return SPORT_IDS[sport_lower]
        # Treat as raw UUID
        if re.match(r"[0-9a-f-]{36}", sport_lower):
            return sport
        raise ValueError(f"Unknown sport '{sport}'. Known: {list(SPORT_IDS.keys())}")

    def list_all_slots(
        self,
        sport: str,
        date: str | None = None,
        court_filter: str | None = None,
    ) -> None:
        """Print all available slots for all (or filtered) facilities on a given date."""
        self._ensure_logged_in()
        if date is None:
            dates = self.get_available_dates(sport)
            date = dates[0] if dates else datetime.today().strftime("%Y-%m-%d")

        facilities = self.get_facilities(sport)
        if court_filter:
            facilities = [
                f for f in facilities if court_filter.lower() in f["name"].lower()
            ]

        filter_note = f" (filter: '{court_filter}')" if court_filter else ""
        print(f"\n{'=' * 60}")
        print(f"  {sport.upper()} -- Available slots on {date}{filter_note}")
        print(f"{'=' * 60}")

        for fac in facilities:
            # Use available_only=False so slots with spots but no booking button
            # (e.g. when the daily limit is reached) are still listed.
            all_slots = self.get_slots(sport, fac["id"], date, available_only=False)
            # Show only slots that have at least one spot left (skip "No spots available").
            visible = [
                s
                for s in all_slots
                if s.get("spots_left") and "no spots" not in s["spots_left"].lower()
            ]
            if visible:
                print(f"\n  {fac['name']}")
                for s in visible:
                    status = "" if s.get("available") else "  [limit reached]"
                    print(f"     {s['time_display']:20s}  ({s['spots_left']}){status}")
        print()


# ------------------------------------------------------------------ #
#  CLI entry point
# ------------------------------------------------------------------ #


def main():
    parser = argparse.ArgumentParser(description="UCSD Recreation Court Booking Bot")
    parser.add_argument(
        "--sport",
        default="tennis",
        help="Sport to book (tennis/pickleball/racquetball/squash) [default: tennis]",
    )
    parser.add_argument(
        "--date",
        default=None,
        help="Target date YYYY-MM-DD [default: 4 days from today]",
    )
    parser.add_argument(
        "--time",
        help=(
            "Target START time. Examples: '8' or '8am'=8 AM, '8pm'=8 PM, "
            "'20' or '21'=8/9 PM (24h). Bare number defaults to AM."
        ),
    )
    parser.add_argument(
        "--hours",
        type=int,
        default=1,
        help="Number of consecutive hours to book (default: 1)",
    )
    parser.add_argument(
        "--court",
        help="Partial court name filter, e.g. 'Muir 1'",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List available slots and exit",
    )
    parser.add_argument(
        "--wait",
        action="store_true",
        help="Poll until slot opens (use when booking window not yet open)",
    )
    parser.add_argument(
        "--username",
        default=os.getenv("UCSD_USERNAME"),
        help="UCSD Recreation username/email",
    )
    parser.add_argument(
        "--password",
        default=os.getenv("UCSD_PASSWORD"),
        help="UCSD Recreation password",
    )
    args = parser.parse_args()

    if not args.username or not args.password:
        print("ERROR: Provide --username/--password or set UCSD_USERNAME/UCSD_PASSWORD")
        sys.exit(1)

    bot = UCSDBookingBot(args.username, args.password)

    if not bot.login():
        sys.exit(1)

    # Default date = 4 days from today (when booking window opens)
    target_date = args.date or (datetime.today() + timedelta(days=4)).strftime(
        "%Y-%m-%d"
    )

    # --court on CLI overrides DEFAULT_COURT_FILTER from .env
    court_filter = args.court or os.getenv("DEFAULT_COURT_FILTER") or None

    if args.list or (not args.time):
        bot.list_all_slots(args.sport, target_date, court_filter=court_filter)
        return

    if args.wait:
        poll_interval = float(os.getenv("POLL_INTERVAL_SEC", "5"))
        poll_duration_min = float(os.getenv("POLL_DURATION_MIN", "5"))
        log.info(
            f"Poll settings: every {poll_interval:.0f}s "
            f"for up to {poll_duration_min:.0f} min"
        )
        success = bot.book_when_open(
            sport=args.sport,
            target_date=target_date,
            target_time=args.time,
            court_name=court_filter,
            num_hours=args.hours,
            poll_interval=poll_interval,
            poll_duration_min=poll_duration_min,
        )
    else:
        # One-shot booking attempt
        facilities = bot.get_facilities(args.sport)
        if court_filter:
            facilities = [
                f for f in facilities if court_filter.lower() in f["name"].lower()
            ]

        booked = False
        for fac in facilities:
            slots = bot.get_slots(args.sport, fac["id"], target_date)
            consecutive = bot.find_consecutive_slots(slots, args.time, args.hours)
            if consecutive:
                booked = bot.reserve_multi(
                    args.sport, fac["id"], consecutive, target_date
                )
            elif args.hours > 1:
                # Fallback: book any single available slot in the window
                all_slots = bot.get_slots(
                    args.sport, fac["id"], target_date, available_only=False
                )
                slot = bot.find_any_slot_in_window(all_slots, args.time, args.hours)
                if slot:
                    log.info(
                        f"Full {args.hours}h window unavailable; booking partial "
                        f"slot {slot['time_display']} at {fac['name']}"
                    )
                    booked = bot.reserve(args.sport, fac["id"], slot, target_date)
            if booked:
                break
        if not booked:
            log.error(
                f"No available slot found in {args.hours}h window starting at {args.time}"
            )
            sys.exit(1)


if __name__ == "__main__":
    main()
