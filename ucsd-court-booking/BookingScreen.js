import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, Button, StyleSheet, ScrollView, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import UCSDBookingBot from './UCSDBookingBot';

const BookingScreen = () => {
  // Helper to calculate date 3 days from now
  const getDefaultDate = () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 3);
    return futureDate.toISOString().split('T')[0];
  };

  const [sport, setSport] = useState('tennis');
  const [date, setDate] = useState(getDefaultDate());
  const [time, setTime] = useState('7:00 PM');
  const [hours, setHours] = useState('1');
  const [court, setCourt] = useState('North');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [bot, setBot] = useState(null);

  useEffect(() => {
    const initBot = async () => {
      const username = await AsyncStorage.getItem('username');
      const password = await AsyncStorage.getItem('password');
      if (username && password) {
        const newBot = new UCSDBookingBot(username, password);
        setBot(newBot);
      }
    };
    initBot();
  }, []);

  const handleListSlots = async () => {
    if (!bot) return;
    setLoading(true);
    try {
      const facilities = await bot.getFacilities(sport);
      let filteredFacilities = facilities;
      if (court) {
        filteredFacilities = facilities.filter(f => f.name.toLowerCase().includes(court.toLowerCase()));
      }

      const allSlots = [];
      for (const fac of filteredFacilities) {
        const slots = await bot.getSlots(sport, fac.id, date);
        allSlots.push({ facility: fac.name, slots });
      }
      setResults(allSlots);
    } catch (error) {
      Alert.alert('Error', error.message);
    }
    setLoading(false);
  };

  const handleBook = async () => {
    if (!bot || !time) {
      Alert.alert('Error', 'Please enter time');
      return;
    }
    setLoading(true);
    try {
      const facilities = await bot.getFacilities(sport);
      let filteredFacilities = facilities;
      if (court) {
        filteredFacilities = facilities.filter(f => f.name.toLowerCase().includes(court.toLowerCase()));
      }

      let booked = false;
      for (const fac of filteredFacilities) {
        // Refresh slots to check current availability
        const slots = await bot.getSlots(sport, fac.id, date);
        const consecutive = bot.findConsecutiveSlots(slots, time, parseInt(hours));
        if (consecutive) {
          booked = await bot.reserveMulti(sport, fac.id, consecutive, date);
          if (booked) {
            Alert.alert('Success', `Booked ${hours} hour(s) at ${fac.name} starting ${consecutive[0].time_display}`);
            break;
          }
        } else if (parseInt(hours) === 1) {
          // Try to book a single slot if consecutive slots not found and hours = 1
          const singleSlot = bot.findSlotByTime(slots, time);
          if (singleSlot) {
            booked = await bot.reserve(sport, fac.id, singleSlot, date);
            if (booked) {
              Alert.alert('Success', `Booked 1 hour at ${fac.name} at ${singleSlot.time_display}`);
              break;
            }
          }
        }
      }
      if (!booked) {
        Alert.alert('Failed', 'No available slots found or booking failed. Slots may have been taken by someone else.');
      }
    } catch (error) {
      Alert.alert('Error', error.message);
    }
    setLoading(false);
  };

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Book Court</Text>

      <Text>Sport:</Text>
      <TextInput
        style={styles.input}
        placeholder="tennis"
        value={sport}
        onChangeText={setSport}
      />

      <Text>Date (YYYY-MM-DD):</Text>
      <TextInput
        style={styles.input}
        placeholder="3 days from now"
        value={date}
        onChangeText={setDate}
      />

      <Text>Time (e.g. 8:00 AM):</Text>
      <TextInput
        style={styles.input}
        placeholder="7:00 PM"
        value={time}
        onChangeText={setTime}
      />

      <Text>Hours:</Text>
      <TextInput
        style={styles.input}
        placeholder="1"
        value={hours}
        onChangeText={setHours}
        keyboardType="numeric"
      />

      <Text>Court Filter:</Text>
      <TextInput
        style={styles.input}
        placeholder="North"
        value={court}
        onChangeText={setCourt}
      />

      <View style={styles.buttonContainer}>
        <Button title={loading ? "Loading..." : "List Available Slots"} onPress={handleListSlots} disabled={loading} />
        <Button title={loading ? "Loading..." : "Book Slot"} onPress={handleBook} disabled={loading} />
      </View>

      {results.length > 0 && (
        <View style={styles.results}>
          <Text style={styles.resultsTitle}>Available Slots:</Text>
          {results.map((fac, idx) => (
            <View key={idx}>
              <Text style={styles.facility}>{fac.facility}</Text>
              {fac.slots.map((slot, sidx) => (
                <Text key={sidx}>  {slot.time_display} ({slot.spots_left})</Text>
              ))}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 20,
  },
  input: {
    height: 40,
    borderColor: 'gray',
    borderWidth: 1,
    marginBottom: 10,
    paddingHorizontal: 10,
  },
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  results: {
    marginTop: 20,
  },
  resultsTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  facility: {
    fontWeight: 'bold',
    marginTop: 10,
  },
});

export default BookingScreen;