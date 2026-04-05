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
  let [hour, minute] = t.split(':').map(Number);
  if (!ampm) {
    if (hour >= 13) {
      ampm = 'pm';
      hour -= 12;
    } else if (hour === 12) {
      ampm = 'pm';
    } else if (hour === 0) {
      ampm = 'am';
      hour = 12;
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

const BASE_URL = "https://rec.ucsd.edu";

// Sport -> booking product ID mapping (discovered via /booking page)
const SPORT_IDS = {
  "tennis": "9f19b678-58ce-4dfc-bd78-7166bde9e265",
  "pickleball": "a5e7e1e2-c5e4-4b3a-9f1d-2c8b3e4f5a6b",
  "racquetball": "b6f8f2f3-d6f5-5c4b-af2e-3d9c4f5g6b7c",
  "squash": "c7g9g3g4-e7g6-6d5c-bg3f-4eAd5g6h7c8d",
};

class UCSDBookingBot {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.session = null; // We'll use fetch with headers
    this._loggedIn = false;
    this.csrfToken = null;
    this.cookieHeader = '';
    this._cachedProductId = null;
  }

  _extractCookies(setCookieHeader) {
    if (!setCookieHeader) return '';
    const rawCookies = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader.split(/,(?=[^\s])/g);
    const cookies = rawCookies
      .map((cookie) => cookie.split(';')[0].trim())
      .filter(Boolean);
    return cookies.join('; ');
  }

  async _fetchWithCookies(url, options = {}) {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      ...options.headers,
    };
    if (this.cookieHeader) {
      headers.Cookie = this.cookieHeader;
    }

    const resp = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
    });

    const setCookie = resp.headers.get('set-cookie');
    if (setCookie) {
      const extracted = this._extractCookies(setCookie);
      if (extracted) {
        this.cookieHeader = extracted;
      }
    }
    return resp;
  }

  async login() {
    try {
      console.log("Fetching login page for CSRF token...");
      const resp = await this._fetchWithCookies(`${BASE_URL}/account/signinoptions`, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: `${BASE_URL}/`,
        },
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const text = await resp.text();
      const csrfMatch = text.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) ||
        text.match(/__LocalAntiForgeryForm[^>]*>[\s\S]*?value="([^"]+)"/);
      if (!csrfMatch) {
        console.error('Login page HTML snippet:', text.slice(0, 800));
        throw new Error("Could not find CSRF token");
      }
      this.csrfToken = csrfMatch[1];

      console.log("Submitting credentials...");
      const loginResp = await this._fetchWithCookies(`${BASE_URL}/account/signin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'en-US,en;q=0.9',
          Origin: BASE_URL,
          Referer: `${BASE_URL}/account/signinoptions`,
        },
        body: new URLSearchParams({
          '__RequestVerificationToken': this.csrfToken,
          'Username': this.username,
          'Password': this.password,
          'Redirect': '/booking',
        }).toString(),
      });

      if (!loginResp.ok) throw new Error(`HTTP ${loginResp.status}`);

      const responseText = await loginResp.text();
      let result;
      try {
        result = JSON.parse(responseText);
      } catch (e) {
        console.error('Login response not JSON:', responseText.slice(0, 800));
        return false;
      }

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
    const productId = await this._getProductId(sport);

    try {
      const resp = await this._fetchWithCookies(`${BASE_URL}/booking/${productId}/facilities`, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: `${BASE_URL}/booking/${productId}`,
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
    const productId = await this._getProductId(sport);

    try {
      const resp = await this._fetchWithCookies(`${BASE_URL}/booking/${productId}/dates`, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: `${BASE_URL}/booking/${productId}`,
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
    const productId = await this._getProductId(sport);
    const [y, m, d] = date.split('-');

    try {
        const resp = await this._fetchWithCookies(`${BASE_URL}/booking/${productId}/slots/${facilityId}/${y}/${m}/${d}`);
        const text = await resp.text();

        // 1. Pre-process the text to remove non-breaking spaces and extra noise
        const cleanText = text.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

        const slots = [];
        // 2. Identify each slot block by finding the start of a card
        const cardBlocks = cleanText.split('data-slot-number="');
        
        // Skip index 0 as it's the header before the first slot
        for (let i = 1; i < cardBlocks.length; i++) {
            const block = cardBlocks[i];
            
            // Extract the slot number (first thing in the string now)
            const slotNum = block.match(/^([^"]+)"/)?.[1];
            
            // Extract Time: Look for the first <strong> content
            const timeMatch = block.match(/<strong>(.*?)<\/strong>/);
            const timeDisplay = timeMatch ? timeMatch[1].trim() : "";

            // Extract Availability Text: Look for the specific "spots available" span
            const spotsMatch = block.match(/<span[^>]*class="text-muted"[^>]*>(.*?)<\/span>/);
            const spotsText = spotsMatch ? spotsMatch[1].trim() : "";

            // Extract the IDs needed for booking
            const aptId = block.match(/data-apt-id="([^"]+)"/)?.[1];
            const tsId = block.match(/data-timeslot-id="([^"]+)"/)?.[1];
            const tsiId = block.match(/data-timeslotinstance-id="([^"]+)"/)?.[1];
            const participantId = block.match(/data-participant-id="([^"]*)"/)?.[1];

            // LOGIC: A slot is available if:
            // - It has an aptId (The "Book Now" button exists)
            // - It doesn't explicitly say "No spots available" or "Full"
            const isFull = spotsText.toLowerCase().includes("no spots") || spotsText.toLowerCase().includes("full");
            const isAvailable = Boolean(aptId) && !isFull;

            let slot = {
                slot_number: slotNum,
                time_display: timeDisplay,
                spots_left: spotsText,
                available: isAvailable,
                participant_id: participantId || "",
            };

            if (isAvailable) {
                slot.apt_id = aptId;
                slot.timeslot_id = tsId;
                slot.timeslotinstance_id = tsiId;
                slot.slot_text = block.match(/data-slot-text="([^"]+)"/)?.[1] || '';
            }

            if (availableOnly && !isAvailable) continue;
            slots.push(slot);
        }
        
        console.log(`Parsed ${slots.length} available slots for ${date}`);
        return slots;
    } catch (error) {
        console.error("Get slots error:", error);
        return [];
    }
}

  async reserve(sport, facilityId, slot, date) {
    await this._ensureLoggedIn();
    
    // Check if slot has required booking data
    if (!slot.apt_id || !slot.timeslot_id || !slot.timeslotinstance_id) {
      console.error('Slot missing required booking data:', slot);
      throw new Error('Slot data is incomplete - cannot book this slot');
    }
    
    const productId = await this._getProductId(sport);
    const [y, m, d] = date.split('-').map((part, index) => {
      if (index === 1 || index === 2) { // month or day
        return part.padStart(2, '0'); // add leading zeros
      }
      return part;
    });

    try {
      const postData = {
        bId: productId,
        fId: facilityId,
        aId: slot.apt_id,
        tsId: slot.timeslot_id,
        tsiId: slot.timeslotinstance_id,
        y: y,
        m: m,
        d: d,
        t: '', // reCAPTCHA token
        v: '0', // version
      };

      console.log(`Reserving ${sport} on ${date} at ${slot.time_display}`);
      console.log('Booking data:', postData);

      const resp = await this._fetchWithCookies(`${BASE_URL}/booking/reserve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: `${BASE_URL}/booking/${productId}`,
        },
        body: JSON.stringify(postData),
      });

      if (!resp.ok) {
        let errorMsg = `HTTP ${resp.status}`;
        try {
          const text = await resp.text();
          if (text.includes('<!DOCTYPE html>') && text.includes('Error')) {
            // Extract error message from HTML
            const titleMatch = text.match(/<title>([^<]+)<\/title>/);
            if (titleMatch) {
              errorMsg += `: ${titleMatch[1]}`;
            } else {
              errorMsg += ': Server error (slot may no longer be available)';
            }
          } else {
            // Try to parse as JSON
            const errorData = JSON.parse(text);
            if (errorData.ErrorMessage) {
              errorMsg += `: ${errorData.ErrorMessage}`;
            }
          }
        } catch (e) {
          errorMsg += ': Server error (slot may no longer be available)';
        }
        console.error(`HTTP ${resp.status} response:`, errorMsg);
        throw new Error(errorMsg);
      }

      const result = await resp.json();
      if (result.Success) {
        console.log("Booking successful!");
        return true;
      } else {
        console.error(`Booking failed: ${JSON.stringify(result)}`);
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
    if (!first) {
      return null;
    }
    const result = [first];
    for (let i = 1; i < numHours; i++) {
      const nextStart = extractStartTime(result[result.length - 1].time_display.split(' - ')[1]);
      const nxt = this.findSlotByTime(slots, nextStart);
      if (!nxt) {
        return null;
      }
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
    const resp = await this._fetchWithCookies(`${BASE_URL}/booking/delete/${participantId}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: `${BASE_URL}/booking`,
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();
    return !!result;
  }

  findAnySlotInWindow(allSlots, targetTime, numHours) {
    let currentTime = targetTime;
    for (let i = 0; i < numHours; i++) {
      const targetNorm = normaliseTime(currentTime);
      let slotInfo = null;
      for (const s of allSlots) {
        const start = extractStartTime(s.time_display);
        if (timesMatch(targetNorm, start)) {
          slotInfo = s;
          break;
        }
      }
      if (!slotInfo) break;
      if (slotInfo.available) {
        return slotInfo;
      }
      // Advance to the next hour using this slot's end time
      const parts = slotInfo.time_display.split(' - ');
      if (parts.length < 2) break;
      currentTime = parts[1].trim();
    }
    return null;
  }

  async bookWhenOpen(sport = "tennis", targetDate = null, targetTime = "19:00", courtName = "North", numHours = 1, pollInterval = 5.0, pollDurationMin = 5.0) {
    const maxAttempts = Math.max(1, Math.floor(pollDurationMin * 60 / pollInterval));
    await this._ensureLoggedIn();

    // Default to 3 days from now if no date provided
    if (!targetDate) {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 3);
      targetDate = futureDate.toISOString().split('T')[0];
    }

    console.log(`Waiting for ${sport} slot on ${targetDate} at ${targetTime} (${numHours}h)${courtName ? ` (${courtName})` : ''}`);

    // Sleep until midnight (next 00:00:00)
    const now = new Date();
    const midnight = new Date(now);
    midnight.setDate(midnight.getDate() + 1);
    midnight.setHours(0, 0, 0, 0);
    const waitSecs = (midnight - now) / 1000;
    console.log(`Sleeping until midnight (${midnight.toISOString().split('T')[0]} 00:00:00) before polling — ${(waitSecs / 3600).toFixed(2)}h (${(waitSecs / 60).toFixed(1)} min) to go...`);
    
    await new Promise(resolve => setTimeout(resolve, waitSecs * 1000));
    console.log("Midnight reached — starting to poll now.");

    let facilities = await this.getFacilities(sport);
    if (courtName) {
      facilities = facilities.filter(f => f.name.toLowerCase().includes(courtName.toLowerCase()));
      if (facilities.length === 0) {
        console.error(`No facility matching '${courtName}'`);
        return false;
      }
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        for (const facility of facilities) {
          const slots = await this.getSlots(sport, facility.id, targetDate);
          const consecutive = this.findConsecutiveSlots(slots, targetTime, numHours);
          if (consecutive) {
            console.log(`Found ${numHours} consecutive slot(s) on attempt ${attempt} at ${facility.name}`);
            return await this.reserveMulti(sport, facility.id, consecutive, targetDate);
          }

          // Fallback: book any single available slot in the window
          if (numHours > 1) {
            const allSlots = await this.getSlots(sport, facility.id, targetDate, false);
            const slot = this.findAnySlotInWindow(allSlots, targetTime, numHours);
            if (slot) {
              console.log(`Full ${numHours}h window unavailable; booking partial slot ${slot.time_display} at ${facility.name}`);
              return await this.reserve(sport, facility.id, slot, targetDate);
            }
          }
        }

        const elapsedMin = (attempt * pollInterval) / 60;
        console.log(`Attempt ${attempt}/${maxAttempts} (${elapsedMin.toFixed(1)}/${pollDurationMin.toFixed(0)} min): no slot yet, retrying in ${pollInterval.toFixed(0)}s...`);
        await new Promise(resolve => setTimeout(resolve, pollInterval * 1000));
      } catch (error) {
        console.warn(`Network error on attempt ${attempt}: ${error}`);
        await new Promise(resolve => setTimeout(resolve, pollInterval * 2 * 1000));
      }
    }

    console.error(`Gave up after ${maxAttempts} attempts`);
    return false;
  }

  async getMyBookings() {
    await this._ensureLoggedIn();
    const resp = await this._fetchWithCookies(`${BASE_URL}/booking/mybookings/10`, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: `${BASE_URL}/booking`,
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  }

  async listAllSlots(sport = "tennis", date = null, courtFilter = "North") {
    await this._ensureLoggedIn();
    if (!date) {
      // Default to 3 days from now
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 3);
      date = futureDate.toISOString().split('T')[0];
    }

    let facilities = await this.getFacilities(sport);
    if (courtFilter) {
      facilities = facilities.filter(f => f.name.toLowerCase().includes(courtFilter.toLowerCase()));
    }

    const filterNote = courtFilter ? ` (filter: '${courtFilter}')` : '';
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${sport.toUpperCase()} -- Available slots on ${date}${filterNote}`);
    console.log(`${'='.repeat(60)}`);

    for (const fac of facilities) {
      const slots = await this.getSlots(sport, fac.id, date);
      if (slots.length > 0) {
        console.log(`\n  ${fac.name}`);
        for (const s of slots) {
          console.log(`     ${s.time_display.padEnd(20)}  (${s.spots_left})`);
        }
      }
    }
    console.log();
  }

  async _getProductId(sport) {
    if (this._cachedProductId) {
      return this._cachedProductId;
    }

    // Try to get product ID from booking page
    try {
      const resp = await this._fetchWithCookies(`${BASE_URL}/booking`, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (resp.ok) {
        const text = await resp.text();
        const productLinks = text.match(/href="\/booking\/([a-f0-9-]+)"/g);
        if (productLinks && productLinks.length > 0) {
          const firstLink = productLinks[0];
          const idMatch = firstLink.match(/\/booking\/([a-f0-9-]+)/);
          if (idMatch) {
            this._cachedProductId = idMatch[1];
            console.log(`Using product ID from booking page: ${idMatch[1]}`);
            return this._cachedProductId;
          }
        }
      }
    } catch (error) {
      console.warn('Failed to get product ID from booking page:', error);
    }

    const sportLower = sport.toLowerCase();
    if (SPORT_IDS[sportLower]) {
      this._cachedProductId = SPORT_IDS[sportLower];
      return this._cachedProductId;
    }
    throw new Error(`Unknown sport '${sport}'. Known: ${Object.keys(SPORT_IDS).join(', ')}`);
  }
}

export default UCSDBookingBot;