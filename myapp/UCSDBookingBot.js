import AsyncStorage from '@react-native-async-storage/async-storage';

// Helper functions for time matching
function normaliseTime(t) {
  t = t.trim().toLowerCase().replace(/\s/g, '');
  let ampm = '';
  if (t.endsWith('am')) {
    ampm = 'am';
    t = t.slice(0, -2);
  } else if (t.endsWith('pm')) {
    ampm = 'pm';
    t = t.slice(0, -2);
  }
  if (!t.includes(':')) t += ':00';
  const [hour, minute] = t.split(':').map(Number);
  if (!ampm) {
    if (hour >= 13) {
      ampm = 'pm';
    } else if (hour === 12) {
      ampm = 'pm';
    } else if (hour === 0) {
      ampm = 'am';
    } else {
      ampm = 'am';
    }
  }
  return `${hour}:${minute.toString().padStart(2, '0')} ${ampm}`;
}

function extractStartTime(timeDisplay) {
  const parts = timeDisplay.split(' - ');
  const startPart = parts[0].trim();
  const endPart = parts[1] ? parts[1].trim() : '';
  const ampmMatch = startPart.match(/\s*(am|pm)$/i);
  if (ampmMatch) {
    return startPart;
  }
  const endAmpm = endPart.match(/(am|pm)$/i);
  if (endAmpm) {
    return `${startPart} ${endAmpm[1]}`;
  }
  return startPart;
}

function timesMatch(target, slotStart) {
  const targetNorm = normaliseTime(target);
  const slotNorm = slotStart.toLowerCase();
  const targetTime = targetNorm.replace(/\s*(am|pm)$/i, '');
  const slotTime = slotNorm.replace(/\s*(am|pm)$/i, '');
  if (targetTime !== slotTime) return false;
  const targetAmpm = targetNorm.match(/(am|pm)$/i);
  const slotAmpm = slotNorm.match(/(am|pm)$/i);
  if (!targetAmpm) return true;
  return targetAmpm[1] === slotAmpm[1];
}

class UCSDBookingBot {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.session = null; // We'll use fetch with headers
    this._loggedIn = false;
    this.csrfToken = null;
  }

  async login() {
    try {
      console.log("Fetching login page for CSRF token...");
      const resp = await fetch(`${BASE_URL}/account/signinoptions`, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const text = await resp.text();
      const csrfMatch = text.match(/__LocalAntiForgeryForm[^>]*>.*?value="([^"]+)"/s);
      if (!csrfMatch) {
        throw new Error("Could not find CSRF token");
      }
      this.csrfToken = csrfMatch[1];

      console.log("Submitting credentials...");
      const loginResp = await fetch(`${BASE_URL}/account/signin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        body: new URLSearchParams({
          '__RequestVerificationToken': this.csrfToken,
          'Username': this.username,
          'Password': this.password,
          'Redirect': '/booking',
        }),
      });

      if (!loginResp.ok) throw new Error(`HTTP ${loginResp.status}`);

      const result = await loginResp.json();
      if (result.IsSucess) {
        console.log("Login successful");
        this._loggedIn = true;
        return true;
      } else {
        console.error(`Login failed: ${result.ErrorMessage || 'unknown error'}`);
        return false;
      }
    } catch (error) {
      console.error("Login error:", error);
      return false;
    }
  }

  async _ensureLoggedIn() {
    if (!this._loggedIn) {
      if (!(await this.login())) {
        throw new Error("Authentication failed");
      }
    }
  }

  async getFacilities(sport) {
    await this._ensureLoggedIn();
    const productId = this._resolveProductId(sport);

    try {
      const resp = await fetch(`${BASE_URL}/booking/${productId}/facilities`, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const text = await resp.text();
      const ids = [...text.matchAll(/data-facility-id="([^"]+)"/g)].map(m => m[1]);
      const names = [...text.matchAll(/data-facility-name="([^"]+)"/g)].map(m => m[1]);

      const seen = new Set();
      const facilities = [];
      for (let i = 0; i < ids.length; i++) {
        const fid = ids[i];
        const fname = names[i];
        if (!seen.has(fid)) {
          seen.add(fid);
          facilities.push({ id: fid, name: fname.trim() });
        }
      }

      console.log(`Found ${facilities.length} facilities for ${sport}`);
      return facilities;
    } catch (error) {
      console.error("Get facilities error:", error);
      return [];
    }
  }

  async getAvailableDates(sport) {
    await this._ensureLoggedIn();
    const productId = this._resolveProductId(sport);

    try {
      const resp = await fetch(`${BASE_URL}/booking/${productId}/dates`, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const text = await resp.text();
      const match = text.match(/id="hdnDates" value="([^"]+)"/);
      if (!match) return [];

      const datesRaw = match[1].replace(/&quot;/g, '"');
      const dates = JSON.parse(datesRaw);
      return dates.map(d => d.slice(0, 10));
    } catch (error) {
      console.error("Get dates error:", error);
      return [];
    }
  }

  async getSlots(sport, facilityId, date, availableOnly = true) {
    await this._ensureLoggedIn();
    const productId = this._resolveProductId(sport);
    const [y, m, d] = date.split('-');

    try {
      const resp = await fetch(`${BASE_URL}/booking/${productId}/slots/${facilityId}/${y}/${m}/${d}`, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const text = await resp.text();
      if (text.startsWith('<!DOCTYPE')) {
        console.warn("Slots endpoint returned full HTML page");
        return [];
      }

      const slots = [];
      const cardPattern = /<div class="card h-100"\s+data-slot-number="(\d+)"\s+data-participant-id="([^"]*)".*?<strong>([^<]+)<\/strong>.*?<span class="text-muted">([^<]+)<\/span>.*?<div class="d-grid[^"]*">(.*?)<\/div>/gs;

      const bookBtnPattern = /data-apt-id="([^"]+)".*?data-timeslot-id="([^"]+)".*?data-timeslotinstance-id="([^"]+)".*?data-slot-text="([^"]+)".*?data-spots-left-text="([^"]+)"/s;

      let match;
      while ((match = cardPattern.exec(text)) !== null) {
        const slotNum = match[1];
        const participantId = match[2];
        const timeDisplay = match[3].trim();
        const spotsText = match[4].trim();
        const actionHtml = match[5];

        const btnMatch = bookBtnPattern.exec(actionHtml);
        const isAvailable = btnMatch !== null;

        const slot = {
          slot_number: slotNum,
          time_display: timeDisplay,
          spots_left: spotsText,
          available: isAvailable,
          participant_id: participantId,
        };

        if (isAvailable) {
          slot.apt_id = btnMatch[1];
          slot.timeslot_id = btnMatch[2];
          slot.timeslotinstance_id = btnMatch[3];
          slot.slot_text = btnMatch[4];
        }

        if (availableOnly && !isAvailable) continue;
        slots.push(slot);
      }

      return slots;
    } catch (error) {
      console.error("Get slots error:", error);
      return [];
    }
  }

  async reserve(sport, facilityId, slot, date) {
    await this._ensureLoggedIn();
    const productId = this._resolveProductId(sport);
    const [y, m, d] = date.split('-');

    try {
      const postData = new URLSearchParams({
        bId: productId,
        fId: facilityId,
        aId: slot.apt_id,
        tsId: slot.timeslot_id,
        tsiId: slot.timeslotinstance_id,
        y: y,
        m: m,
        d: d,
        t: '', // reCAPTCHA token
        v: '0',
      });

      console.log(`Reserving ${sport} on ${date} at ${slot.time_display}`);

      const resp = await fetch(`${BASE_URL}/booking/reserve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        body: postData,
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const result = await resp.json();
      if (result.Success) {
        console.log("Booking successful!");
        return true;
      } else {
        console.error(`Booking failed: ${result}`);
        return false;
      }
    } catch (error) {
      console.error("Reserve error:", error);
      return false;
    }
  }

  findSlotByTime(slots, targetTime) {
    const targetNorm = normaliseTime(targetTime);
    for (const slot of slots) {
      if (!slot.available) continue;
      const start = extractStartTime(slot.time_display);
      if (timesMatch(targetNorm, start)) {
        return slot;
      }
    }
    return null;
  }

  findConsecutiveSlots(slots, targetTime, numHours = 1) {
    if (numHours <= 0) return [];
    const first = this.findSlotByTime(slots, targetTime);
    if (!first) return null;
    const result = [first];
    for (let i = 1; i < numHours; i++) {
      const nextStart = extractStartTime(result[result.length - 1].time_display.split(' - ')[1]);
      const nxt = this.findSlotByTime(slots, nextStart);
      if (!nxt) return null;
      result.push(nxt);
    }
    return result;
  }

  async reserveMulti(sport, facilityId, slots, date) {
    const bookedIds = [];
    for (const slot of slots) {
      const success = await this.reserve(sport, facilityId, slot, date);
      if (!success) {
        // Cancel previous
        for (const pid of bookedIds) {
          await this.cancel(pid);
        }
        return false;
      }
      bookedIds.push(slot.participant_id);
    }
    return true;
  }

  async cancel(participantId) {
    await this._ensureLoggedIn();
    const resp = await fetch(`${BASE_URL}/booking/delete/${participantId}`, {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();
    return result === true;
  }

  _resolveProductId(sport) {
    const sportLower = sport.toLowerCase();
    if (SPORT_IDS[sportLower]) {
      return SPORT_IDS[sportLower];
    }
    if (/^[0-9a-f-]{36}$/.test(sportLower)) {
      return sport;
    }
    throw new Error(`Unknown sport '${sport}'. Known: ${Object.keys(SPORT_IDS).join(', ')}`);
  }
}

export default UCSDBookingBot;