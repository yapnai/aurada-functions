const AWS = require('aws-sdk');

// Configure AWS region (Lambda uses IAM role for credentials)
AWS.config.update({ 
  region: process.env.AWS_REGION || 'us-east-1'
});
const dynamodb = new AWS.DynamoDB.DocumentClient();

const PHONE_NUMBER_CLIENT_MAP_TABLE = process.env.PHONE_NUMBER_CLIENT_MAP_TABLE || 'phoneNumberClientMap';
const CLIENT_DATABASE_TABLE = process.env.CLIENT_DATABASE_TABLE || 'clientDatabase';
const CLIENT_MENU_TABLE = process.env.CLIENT_MENU_TABLE || 'clientMenu';

// Helper function to parse hours string (e.g., "11:00-22:00")
function parseHours(hoursString) {
  if (!hoursString) return null;
  
  const [openStr, closeStr] = hoursString.split('-');
  if (!openStr || !closeStr) return null;
  
  const [openHour, openMin] = openStr.split(':').map(Number);
  const [closeHour, closeMin] = closeStr.split(':').map(Number);
  
  const openTime = openHour * 60 + openMin;
  let closeTime = closeHour * 60 + closeMin;
  
  // Handle midnight: "00:00" should be treated as end of day (1440 minutes)
  if (closeTime === 0) {
    closeTime = 1440;
  }
  
  return { openTime, closeTime };
}

// Helper function to format time for speech (e.g., "11:00" -> "11:00 AM")
function formatTimeForSpeech(timeString) {
  if (!timeString) return '';
  
  const [hour, minute] = timeString.split(':').map(Number);
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  
  return `${displayHour}:${minute.toString().padStart(2, '0')} ${period}`;
}

// Helper function to format hours range for speech
function formatHoursForSpeech(hoursString) {
  if (!hoursString) return 'hours not available';
  
  const [openStr, closeStr] = hoursString.split('-');
  const openFormatted = formatTimeForSpeech(openStr);
  const closeFormatted = formatTimeForSpeech(closeStr);
  
  return `${openFormatted} to ${closeFormatted}`;
}

// Helper function to format all weekly hours for speech
function formatWeeklyHoursForSpeech(restaurantHours) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  const formattedHours = [];
  
  dayNames.forEach((dayName) => {
    const dayHours = restaurantHours[dayName];
    if (dayHours && dayHours.toUpperCase() !== 'CLOSED') {
      const formattedRange = formatHoursForSpeech(dayHours);
      formattedHours.push(`${dayName}: ${formattedRange}`);
    } else {
      formattedHours.push(`${dayName}: closed`);
    }
  });
  
  return formattedHours.join('\n');
}

// Helper function to get today's date in MM/DD format
function getTodayDateString(timeZone) {
  const now = new Date();
  const localTime = new Date(now.toLocaleString("en-US", {timeZone: timeZone}));
  const month = (localTime.getMonth() + 1).toString(); // No padding
  const day = localTime.getDate().toString(); // No padding
  return `${month}/${day}`;
}

// Helper function to find if today is a holiday
function findTodayHoliday(holidayHours, timeZone) {
  if (!holidayHours || !Array.isArray(holidayHours) || holidayHours.length === 0) {
    return null;
  }
  
  const todayDate = getTodayDateString(timeZone);
  const holiday = holidayHours.find(h => h.date === todayDate);
  
  return holiday || null;
}

// Helper function to format all holiday hours for speech
function formatHolidayHoursForSpeech(holidayHours) {
  if (!holidayHours || !Array.isArray(holidayHours) || holidayHours.length === 0) {
    return 'No special holiday hours';
  }
  
  const formattedHolidays = holidayHours.map(holiday => {
    const hoursText = holiday.hours.toUpperCase() === 'CLOSED' 
      ? 'CLOSED' 
      : formatHoursForSpeech(holiday.hours);
    
    return `${holiday.name} on ${holiday.date}: ${hoursText}`;
  });
  
  return formattedHolidays.join(', ');
}

// Helper function to get the Nth occurrence of a weekday in a month
function getNthWeekdayOfMonth(year, month, weekday, n) {
  // weekday: 0=Sunday, 1=Monday, ..., 6=Saturday
  // n: 1=first, 2=second, 3=third, 4=fourth
  
  // Start at the 1st day of the month
  const date = new Date(year, month, 1);
  
  // Find the first occurrence of the desired weekday
  while (date.getDay() !== weekday) {
    date.setDate(date.getDate() + 1);
  }
  
  // Now jump forward (n-1) weeks
  date.setDate(date.getDate() + (n - 1) * 7);
  
  return date.getDate(); // Returns day number
}

// Helper function to get the last occurrence of a weekday in a month
function getLastWeekdayOfMonth(year, month, weekday) {
  // weekday: 0=Sunday, 1=Monday, ..., 6=Saturday
  
  // Start at the last day of the month
  const date = new Date(year, month + 1, 0); // Day 0 = last day of previous month
  
  // Walk backwards until we find the desired weekday
  while (date.getDay() !== weekday) {
    date.setDate(date.getDate() - 1);
  }
  
  return date.getDate(); // Returns day number
}

// Helper function to calculate Easter date using Computus algorithm (Anonymous Gregorian algorithm)
function calculateEaster(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1; // 0-indexed month
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  
  return { month, day };
}

// Helper function to get holiday greeting based on current date
function getHolidayGreeting(timeZone) {
  try {
    // Get current date in restaurant's timezone
    const now = new Date();
    const localTime = new Date(now.toLocaleString("en-US", {timeZone: timeZone}));
    
    const year = localTime.getFullYear();
    const month = localTime.getMonth(); // 0-indexed (0=Jan, 11=Dec)
    const day = localTime.getDate();
    
    // PRIORITY 1: Check fixed date holidays first (most specific)
    
    // January
    if (month === 0 && day >= 1 && day <= 11) return "Happy New Year!";
    
    // February
    if (month === 1 && day >= 6 && day <= 8) return "Happy Super Bowl Weekend!";
    if (month === 1 && day === 9) return "Happy National Pizza Day!";
    if (month === 1 && day >= 10 && day <= 14) return "Happy Valentine's Day!";
    
    // March
    if (month === 2 && day === 14) return "Happy Pi Day!";
    if (month === 2 && day === 17) return "Happy St. Patrick's Day!";
    
    // April
    if (month === 3 && day === 22) return "Happy Earth Day!";
    
    // May
    if (month === 4 && day === 5) return "Happy Cinco de Mayo!";
    
    // July
    if (month === 6 && day === 4) return "Happy Fourth of July!";
    
    // October
    if (month === 9 && day === 31) return "Happy Halloween!";
    
    // November
    if (month === 10 && day === 11) return "Happy Veterans Day!";
    
    // December
    if (month === 11 && day === 31) return "Happy New Year's Eve!";
    
    // PRIORITY 2: Check calculated variable date holidays
    
    // MLK Day Weekend (3rd Monday of January, plus surrounding days)
    if (month === 0) {
      const mlkDay = getNthWeekdayOfMonth(year, 0, 1, 3); // 1=Monday
      if (day >= mlkDay - 1 && day <= mlkDay + 1) return "Happy MLK Day Weekend!";
    }
    
    // Super Bowl Sunday (1st Sunday of February)
    if (month === 1) {
      const superBowlDay = getNthWeekdayOfMonth(year, 1, 0, 1); // 0=Sunday
      if (day === superBowlDay) return "Happy Super Bowl Sunday!";
    }
    
    // Lunar New Year (varies by year - lunar calendar based)
    // 2026: Feb 17, 2027: Feb 6, 2028: Jan 26
    const lunarNewYearDates = {
      2026: { month: 1, day: 17 },
      2027: { month: 1, day: 6 },
      2028: { month: 0, day: 26 }
    };
    const lunarDate = lunarNewYearDates[year];
    if (lunarDate && month === lunarDate.month && day >= lunarDate.day - 1 && day <= lunarDate.day + 1) {
      return "Happy Lunar New Year!";
    }
    
    // Presidents' Day (3rd Monday of February)
    if (month === 1) {
      const presidentsDayDay = getNthWeekdayOfMonth(year, 1, 1, 3); // 1=Monday
      if (day === presidentsDayDay) return "Happy Presidents' Day!";
    }
    
    // Easter (calculated)
    const easter = calculateEaster(year);
    if (month === easter.month && day === easter.day) return "Happy Easter!";
    
    // Memorial Day (Last Monday of May)
    if (month === 4) {
      const memorialDay = getLastWeekdayOfMonth(year, 4, 1); // 1=Monday
      if (day === memorialDay) return "Happy Memorial Day!";
    }
    
    // Father's Day (3rd Sunday of June)
    if (month === 5) {
      const fathersDayDay = getNthWeekdayOfMonth(year, 5, 0, 3); // 0=Sunday
      if (day === fathersDayDay) return "Happy Father's Day!";
    }
    
    // Labor Day (1st Monday of September)
    if (month === 8) {
      const laborDayDay = getNthWeekdayOfMonth(year, 8, 1, 1); // 1=Monday
      if (day === laborDayDay) return "Happy Labor Day!";
    }
    
    // Thanksgiving (4th Thursday of November)
    if (month === 10) {
      const thanksgivingDay = getNthWeekdayOfMonth(year, 10, 4, 4); // 4=Thursday
      if (day === thanksgivingDay) return "Happy Thanksgiving!";
    }
    
    // PRIORITY 3: Check date ranges (multi-day events)
    
    // March Madness (March 15 - April 10)
    if ((month === 2 && day >= 15) || (month === 3 && day <= 10)) {
      return "Happy March Madness!";
    }
    
    // PRIORITY 4: Check month-long greetings (least specific)
    
    // Happy Holidays (entire December, but not on specific holidays already handled)
    if (month === 11) return "Happy Holidays!";
    
    // No holiday greeting for today
    return null;
    
  } catch (error) {
    console.warn('Error getting holiday greeting:', error.message);
    return null;
  }
}

// ============================================================================
// SPORTS EVENTS FUNCTIONS - ESPN API Integration
// ============================================================================

// Helper function to fetch all teams for a specific sport from ESPN
async function fetchAllTeamsForSport(sport) {
  const sportMap = {
    'nfl': 'football/nfl',
    'nba': 'basketball/nba',
    'mlb': 'baseball/mlb',
    'nhl': 'hockey/nhl'
  };
  
  const sportPath = sportMap[sport.toLowerCase()];
  if (!sportPath) {
    console.warn(`Unknown sport: ${sport}`);
    return [];
  }
  
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/teams`;
  console.log(`Fetching teams from ESPN for ${sport}: ${url}`);
  
  try {
    const https = require('https');
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('ESPN API timeout'));
      }, 5000); // 5 second timeout
      
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON from ESPN'));
          }
        });
      }).on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    
    // Parse teams from ESPN response structure
    if (response.sports && response.sports[0].leagues && response.sports[0].leagues[0].teams) {
      const teams = response.sports[0].leagues[0].teams;
      
      const parsedTeams = teams.map(t => ({
        id: t.team.id,
        slug: t.team.abbreviation.toLowerCase(),
        name: t.team.displayName,
        location: t.team.location,
        sport: sport.toUpperCase()
      }));
      
      console.log(`Fetched ${parsedTeams.length} ${sport.toUpperCase()} teams from ESPN`);
      return parsedTeams;
    }
    
    console.warn(`No teams found in ESPN response for ${sport}`);
    return [];
  } catch (error) {
    console.error(`Error fetching ${sport} teams from ESPN:`, error.message);
    return [];
  }
}

// Helper function to fetch all teams from ESPN (no caching for fresh data)
async function getAllTeamsFromESPN() {
  console.log('Fetching all teams from ESPN API (fresh data)...');
  
  const sports = ['nfl', 'nba', 'mlb', 'nhl']; // Only major 4 sports, no MLS
  const allTeams = [];
  
  // Fetch all sports in parallel for speed
  const promises = sports.map(sport => fetchAllTeamsForSport(sport));
  const results = await Promise.all(promises);
  
  results.forEach(teams => allTeams.push(...teams));
  
  console.log(`Fetched ${allTeams.length} total teams from ESPN`);
  return allTeams;
}

// Helper function to find teams by city name
function findTeamsByCity(allTeams, cityName) {
  const normalizedCity = cityName.toLowerCase().trim();
  
  const matches = allTeams.filter(team => {
    const teamLocation = team.location.toLowerCase();
    
    // Exact match
    if (teamLocation === normalizedCity) return true;
    
    // Partial match (handles "Washington" vs "Washington D.C.")
    if (teamLocation.includes(normalizedCity) || normalizedCity.includes(teamLocation)) {
      return true;
    }
    
    // Handle special cases
    if (normalizedCity === 'dc' && teamLocation.includes('washington')) return true;
    if (normalizedCity === 'la' && teamLocation.includes('los angeles')) return true;
    if (normalizedCity === 'sf' && teamLocation.includes('san francisco')) return true;
    if (normalizedCity === 'ny' && teamLocation.includes('new york')) return true;
    
    return false;
  });
  
  console.log(`Found ${matches.length} teams in ${cityName}: ${matches.map(t => t.name).join(', ')}`);
  return matches;
}

// Helper function to fetch upcoming games for a team from ESPN
async function getUpcomingGamesFromESPN(sport, teamSlug, daysAhead = 7) {
  const sportMap = {
    'nfl': 'football/nfl',
    'nba': 'basketball/nba',
    'mlb': 'baseball/mlb',
    'nhl': 'hockey/nhl'
  };
  
  const sportPath = sportMap[sport.toLowerCase()];
  if (!sportPath) {
    console.warn(`Unknown sport for schedule: ${sport}`);
    return [];
  }
  
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/teams/${teamSlug}/schedule`;
  
  try {
    const https = require('https')
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('ESPN schedule timeout'));
      }, 5000);
      
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON from ESPN schedule'));
          }
        });
      }).on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    
    const now = new Date();
    const futureDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    const upcomingGames = [];
    
    if (response.events && Array.isArray(response.events)) {
      for (const event of response.events) {
        const gameDate = new Date(event.date);
        
        // Only include upcoming games in the next 'daysAhead' days
        if (gameDate >= now && gameDate <= futureDate) {
          const competitors = event.competitions[0].competitors;
          const homeTeam = competitors.find(c => c.homeAway === 'home');
          const awayTeam = competitors.find(c => c.homeAway === 'away');
          
          const ourTeamIsHome = homeTeam?.team.abbreviation.toLowerCase() === teamSlug.toLowerCase();
          const opponent = ourTeamIsHome ? awayTeam : homeTeam;
          
          upcomingGames.push({
            date: gameDate,
            opponent: opponent?.team.displayName || 'TBD',
            isHome: ourTeamIsHome,
            time: event.date
          });
        }
      }
    }
    
    console.log(`Found ${upcomingGames.length} upcoming games for ${teamSlug}`);
    return upcomingGames;
    
  } catch (error) {
    console.error(`Error fetching schedule for ${teamSlug}:`, error.message);
    return [];
  }
}

// Helper function to format games for agent with full context
function formatUpcomingGamesForAgent(games, timeZone) {
  if (!games || games.length === 0) {
    return '';
  }
  
  const formatted = games.map(game => {
    // ESPN returns times in UTC, convert to restaurant's timezone
    const gameDate = new Date(game.time); // This is UTC
    
    // Get day name in restaurant's timezone
    const dayOfWeek = gameDate.toLocaleString('en-US', {
      weekday: 'long',
      timeZone: timeZone
    });
    
    // Get date (MM/DD) in restaurant's timezone
    const month = parseInt(gameDate.toLocaleString('en-US', {
      month: 'numeric',
      timeZone: timeZone
    }));
    const day = parseInt(gameDate.toLocaleString('en-US', {
      day: 'numeric',
      timeZone: timeZone
    }));
    const dateStr = `${month}/${day}`;
    
    // Get time in restaurant's timezone
    const timeStr = gameDate.toLocaleString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true,
      timeZone: timeZone
    });
    
    const vs = game.isHome ? 'vs' : 'at';
    
    // Format: "Washington Wizards play Sunday (12/28) 8:15 PM vs Dallas Cowboys"
    return `${game.teamName} play ${dayOfWeek} (${dateStr}) ${timeStr} ${vs} ${game.opponent}`;
  });
  
  return formatted.join('. ') + '.';
}

// Helper function to get upcoming holidays within the next N days
function getUpcomingHolidays(holidayHours, timeZone, daysAhead = 14) {
  if (!holidayHours || !Array.isArray(holidayHours) || holidayHours.length === 0) {
    return [];
  }
  
  const now = new Date();
  const localTime = new Date(now.toLocaleString("en-US", {timeZone: timeZone}));
  
  const upcomingHolidays = [];
  
  // Check each day in the next daysAhead days
  for (let i = 0; i <= daysAhead; i++) {
    const checkDate = new Date(localTime);
    checkDate.setDate(localTime.getDate() + i);
    
    const month = (checkDate.getMonth() + 1).toString();
    const day = checkDate.getDate().toString();
    const dateString = `${month}/${day}`;
    
    // Find if this date is a holiday
    const holiday = holidayHours.find(h => h.date === dateString);
    
    if (holiday) {
      // Determine relative label with day name and date
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const dayName = dayNames[checkDate.getDay()];
      
      let relativeLabel;
      if (i === 0) {
        relativeLabel = `Today (${dayName} ${dateString})`;
      } else if (i === 1) {
        relativeLabel = `Tomorrow (${dayName} ${dateString})`;
      } else {
        relativeLabel = `${dayName} (${dateString})`;
      }
      
      // Format hours text
      const hoursText = holiday.hours.toUpperCase() === 'CLOSED' 
        ? 'CLOSED' 
        : `Special hours ${formatHoursForSpeech(holiday.hours)}`;
      
      upcomingHolidays.push({
        date: holiday.date,
        name: holiday.name,
        relativeLabel: relativeLabel,
        hoursText: hoursText,
        daysFromNow: i
      });
    }
  }
  
  return upcomingHolidays;
}

// Helper function to format upcoming holidays for inclusion in store_hours
function formatUpcomingHolidaysForStoreHours(holidayHours, timeZone) {
  const upcomingHolidays = getUpcomingHolidays(holidayHours, timeZone, 14);
  
  if (upcomingHolidays.length === 0) {
    return '';
  }
  
  const formattedLines = upcomingHolidays.map(holiday => {
    return `${holiday.relativeLabel}: ${holiday.hoursText} for ${holiday.name}`;
  });
  
  return 'UPCOMING CLOSURES AND SPECIAL HOURS:\n' + formattedLines.join('\n') + '\n\n';
}

// Helper function to calculate store status based on dynamic hours
function calculateDynamicStoreStatus(restaurantHours, holidayHours, timeZone) {
  try {
    // Get current time in restaurant's timezone
    const now = new Date();
    const localTime = new Date(now.toLocaleString("en-US", {timeZone: timeZone}));
    
    // PRIORITY 1: Check if today is a holiday
    const todayHoliday = findTodayHoliday(holidayHours, timeZone);
    
    if (todayHoliday) {
      console.log(`Today is a holiday: ${todayHoliday.name} with hours: ${todayHoliday.hours}`);
      
      // Format weekly hours
      const weeklyHoursFormatted = formatWeeklyHoursForSpeech(restaurantHours || {});
      
      // Prepend upcoming holidays to store hours
      const upcomingHolidaysSection = formatUpcomingHolidaysForStoreHours(holidayHours, timeZone);
      const fullStoreHours = upcomingHolidaysSection + weeklyHoursFormatted;
      
      if (todayHoliday.hours.toUpperCase() === 'CLOSED') {
        return {
          status: "store is closed. You cannot order at this time. Please call back when we are open to place an order.",
          allHours: fullStoreHours
        };
      }
      
      // Parse holiday hours
      const parsedHours = parseHours(todayHoliday.hours);
      if (!parsedHours) {
        return {
          status: "store hours not available.",
          allHours: fullStoreHours
        };
      }
      
      // Check if currently open using holiday hours
      const currentTimeInMinutes = localTime.getHours() * 60 + localTime.getMinutes();
      console.log(`Holiday: ${todayHoliday.name}, Hours: ${todayHoliday.hours}, Current: ${currentTimeInMinutes}`);
      const isOpen = currentTimeInMinutes >= parsedHours.openTime && currentTimeInMinutes < parsedHours.closeTime;
      
      const status = isOpen 
        ? "store is open." 
        : "store is closed. You cannot order at this time. Please call back when we are open to place an order.";
      
      return {
        status: status,
        allHours: fullStoreHours
      };
    }
    
    // PRIORITY 2: If not a holiday, continue with existing day-of-week logic
    const dayOfWeek = localTime.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const todayName = dayNames[dayOfWeek];
    
    // Get today's hours
    const todayHours = restaurantHours?.[todayName];
    if (!todayHours || todayHours.toUpperCase() === 'CLOSED') {
      return {
        status: "store is closed. You cannot order at this time. Please call back when we are open to place an order.",
        allHours: formatWeeklyHoursForSpeech(restaurantHours || {})
      };
    }
    
    // Parse hours
    const parsedHours = parseHours(todayHours);
    if (!parsedHours) {
      return {
        status: "store hours not available.",
        allHours: formatWeeklyHoursForSpeech(restaurantHours || {})
      };
    }
    
    // Check if currently open
    const currentTimeInMinutes = localTime.getHours() * 60 + localTime.getMinutes();
    console.log(`Day: ${todayName}, Hours string: ${todayHours}, Parsed: open=${parsedHours.openTime}, close=${parsedHours.closeTime}, Current: ${currentTimeInMinutes}`);
    const isOpen = currentTimeInMinutes >= parsedHours.openTime && currentTimeInMinutes < parsedHours.closeTime;
    
    const status = isOpen ? 
      "store is open." : 
      "store is closed. You cannot order at this time. Please call back when we are open to place an order.";
    
    // Format weekly hours
    const allHoursFormatted = formatWeeklyHoursForSpeech(restaurantHours || {});
    
    // Prepend upcoming holidays to store hours
    const upcomingHolidaysSection = formatUpcomingHolidaysForStoreHours(holidayHours, timeZone);
    const fullStoreHours = upcomingHolidaysSection + allHoursFormatted;
    
    return {
      status: status,
      allHours: fullStoreHours
    };
  } catch (error) {
    console.warn('Error calculating store status:', error.message);
    return {
      status: "store status unavailable.",
      allHours: "hours not available"
    };
  }
}

module.exports.handleInboundCall = async (event) => {
  console.log('Handling inbound call webhook...');
  
  try {
    // Parse the request body
    let body;
    if (typeof event.body === 'string') {
      body = JSON.parse(event.body);
    } else {
      body = event.body;
    }

    console.log('Inbound call payload:', JSON.stringify(body, null, 2));

    // Validate that this is a call_inbound event
    if (body.event !== 'call_inbound') {
      console.error('Invalid event type:', body.event);
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: JSON.stringify({
          error: 'Invalid event type. Expected call_inbound',
          received: body.event
        })
      };
    }

    // Extract the from_number (customer) and to_number (restaurant) from the call_inbound object
    const fromNumber = body.call_inbound?.from_number;
    const toNumber = body.call_inbound?.to_number;
    
    if (!fromNumber) {
      console.error('Missing from_number in call_inbound payload');
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: JSON.stringify({
          error: 'Missing from_number in call_inbound payload',
          received: body.call_inbound
        })
      };
    }

    if (!toNumber) {
      console.error('Missing to_number in call_inbound payload');
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        },
        body: JSON.stringify({
          error: 'Missing to_number in call_inbound payload - cannot determine location',
          received: body.call_inbound
        })
      };
    }

    console.log('Extracted from_number (customer):', fromNumber);
    console.log('Extracted to_number (restaurant):', toNumber);

    // Step 1: Get location ID from phone number
    let locationData;
    try {
      locationData = await getLocationFromPhoneNumber(toNumber);
      console.log(`Found location ID: ${locationData.locationId}`);
    } catch (error) {
      console.warn('Location lookup failed:', error.message);
      locationData = { locationId: '' };
    }

    // Step 2: Get restaurant details from clientDatabase
    let restaurantData;
    try {
      restaurantData = await getRestaurantDetails(locationData.locationId);
      console.log(`Found restaurant: ${restaurantData.restaurantName} at ${restaurantData.address}`);
    } catch (error) {
      console.warn('Restaurant details lookup failed:', error.message);
      restaurantData = { restaurantName: 'Restaurant', address: 'Address not available', hours: {} };
    }

    // Step 3: Calculate dynamic store status using database hours
    const timeZone = restaurantData?.timeZone || "America/New_York";
    let storeInfo;
    try {
      storeInfo = calculateDynamicStoreStatus(restaurantData.hours, restaurantData.holidayHours, timeZone);
      console.log('Store status calculated:', storeInfo.status);
    } catch (error) {
      console.warn('Store status calculation failed:', error.message);
      storeInfo = { status: 'Store status unavailable', allHours: 'Hours not available' };
    }

    // Step 4: Get location-specific menu items
    let menuItemNames = [];
    try {
      menuItemNames = await getLocationSpecificMenuItems(restaurantData.restaurantName, locationData.locationId);
    } catch (error) {
      console.warn('Menu lookup failed, continuing without menu:', error.message);
      menuItemNames = [];
    }

    // Step 5: Format holiday hours for the dynamic variable
    let holidayHoursFormatted = 'No special holiday hours';
    try {
      holidayHoursFormatted = formatHolidayHoursForSpeech(restaurantData.holidayHours);
    } catch (error) {
      console.warn('Holiday hours formatting failed:', error.message);
    }

    // Step 6: Check for holiday greeting if enabled
    let finalGreeting = restaurantData?.greetingPhrase || '';
    if (restaurantData?.holidayGreetings === true) {
      try {
        const holidayGreeting = getHolidayGreeting(timeZone);
        if (holidayGreeting) {
          finalGreeting = `${holidayGreeting} ${finalGreeting}`;
          console.log(`Holiday greeting applied: ${holidayGreeting}`);
        }
      } catch (error) {
        console.warn('Holiday greeting check failed:', error.message);
      }
    }

    // Step 7: Get upcoming sports events from ESPN if configured
    let upcomingSportsEvents = '';
    if (restaurantData?.sportsTeams && Array.isArray(restaurantData.sportsTeams) && restaurantData.sportsTeams.length > 0) {
      try {
        console.log(`Fetching sports events for cities: ${restaurantData.sportsTeams.join(', ')}`);
        
        // Fetch all teams from ESPN (uses cache)
        const allTeams = await getAllTeamsFromESPN();
        
        const allGames = [];
        
        // For each city the restaurant cares about
        for (const cityName of restaurantData.sportsTeams) {
          // Find all teams in that city
          const cityTeams = findTeamsByCity(allTeams, cityName);
          
          // Fetch schedules for each team
          for (const team of cityTeams) {
            const games = await getUpcomingGamesFromESPN(team.sport, team.slug, 7);
            
            // Add team context to each game
            games.forEach(game => {
              allGames.push({
                ...game,
                teamName: team.name,
                sport: team.sport
              });
            });
          }
        }
        
        console.log(`Found ${allGames.length} total upcoming games across all teams`);
        
        // Group games by sport and take only the earliest game from each sport
        const gamesBySport = {};
        for (const game of allGames) {
          if (!gamesBySport[game.sport]) {
            gamesBySport[game.sport] = [];
          }
          gamesBySport[game.sport].push(game);
        }
        
        // Take earliest game from each sport
        const selectedGames = [];
        for (const sport of ['NFL', 'NBA', 'NHL', 'MLB']) {
          if (gamesBySport[sport] && gamesBySport[sport].length > 0) {
            // Sort by date and take first
            gamesBySport[sport].sort((a, b) => new Date(a.time) - new Date(b.time));
            selectedGames.push(gamesBySport[sport][0]);
          }
        }
        
        console.log(`Selected ${selectedGames.length} games (one per sport)`);
        
        // Sort selected games by date
        selectedGames.sort((a, b) => new Date(a.time) - new Date(b.time));
        
        if (selectedGames.length > 0) {
          upcomingSportsEvents = formatUpcomingGamesForAgent(selectedGames, timeZone);
          console.log('Upcoming sports events formatted:', upcomingSportsEvents);
        }
        
      } catch (error) {
        console.warn('Sports events lookup failed:', error.message);
      }
    }

    // Return the response with enhanced dynamic variables
    const response = {
      call_inbound: {
        dynamic_variables: {
          caller_number: fromNumber,
          restaurant_name: restaurantData?.restaurantName || 'Restaurant',
          restaurant_address: restaurantData?.address || 'Address not available',
          location_id: locationData?.locationId || '',
          transfer_number: restaurantData?.transferNumber || '',
          greeting_phrase: finalGreeting,
          menu_item_names: menuItemNames?.join(', ') || 'Menu not available',
          store_status: storeInfo?.status || 'Store status unavailable',
          store_hours: storeInfo?.allHours || 'Hours not available',
          holiday_hours: holidayHoursFormatted,
          upcoming_sports_events: upcomingSportsEvents || 'No upcoming games scheduled'
        },
        metadata: {
          request_timestamp: new Date().toISOString()
        }
      }
    };

    // Add knowledge base override if kbID exists for this location
    if (restaurantData?.kbID) {
      response.call_inbound.agent_override = {
        retell_llm: {
          knowledge_base_ids: [restaurantData.kbID]
        }
      };
      console.log(`Knowledge base override applied: ${restaurantData.kbID}`);
    }

    console.log('Final dynamic variables payload:', JSON.stringify(response.call_inbound.dynamic_variables, null, 2));
    console.log('Returning response with menu items:', JSON.stringify(response, null, 2));

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify(response)
    };

  } catch (error) {
    console.error('Error handling inbound call:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: JSON.stringify({
        error: 'Internal server error',
        details: error.message
      })
    };
  }
}; 

// Helper function to get location ID from phone number
async function getLocationFromPhoneNumber(phoneNumber) {
  try {
    console.log(`Looking up location for phone number: ${phoneNumber}`);
    
    const params = {
      TableName: PHONE_NUMBER_CLIENT_MAP_TABLE,
      Key: { phoneNumber: phoneNumber }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      throw new Error(`No location found for phone number: ${phoneNumber}`);
    }
    
    console.log(`Found location ID: ${result.Item.locationId}`);
    return {
      locationId: result.Item.locationId
    };
  } catch (error) {
    console.error('Error looking up location:', error);
    throw error;
  }
}

// Helper function to get restaurant details from clientDatabase
async function getRestaurantDetails(locationId) {
  try {
    console.log(`Getting restaurant details for location: ${locationId}`);
    
    const params = {
      TableName: CLIENT_DATABASE_TABLE,
      Key: { locationId: locationId }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      throw new Error(`No restaurant found for location ID: ${locationId}`);
    }
    
    console.log(`Found restaurant: ${result.Item.restaurantName}`);
    return result.Item;
  } catch (error) {
    console.error('Error getting restaurant details:', error);
    throw error;
  }
}

// Helper function to get location-specific menu items from clientMenu table
async function getLocationSpecificMenuItems(restaurantName, locationId) {
  try {
    console.log(`Getting menu for: ${restaurantName} at location: ${locationId}`);
    
    const params = {
      TableName: CLIENT_MENU_TABLE,
      Key: { 
        restaurantName: restaurantName,
        locationID: locationId 
      }
    };
    
    const result = await dynamodb.get(params).promise();
    
    if (!result.Item) {
      console.warn(`No menu found for ${restaurantName} at location ${locationId}`);
      return [];
    }
    
    console.log(`Found menu with ${result.Item.itemCount || 'unknown'} items`);
    
    // Extract menu item names (skip metadata fields)
    const metadataFields = ['restaurantName', 'locationID', 'locationName', 'lastUpdated', 'itemCount'];
    const menuItemNames = Object.entries(result.Item)
      .filter(([key, value]) => !metadataFields.includes(key))
      .map(([itemName, itemData]) => {
        // Extract price from itemData
        const price = itemData.price || 0;
        const formattedPrice = (price / 100).toFixed(2); // Convert cents to dollars
        
        // Add description if available
        const description = itemData.description && itemData.description.trim() 
          ? ` - ${itemData.description}` 
          : '';
        
        return `${itemName} $${formattedPrice}${description}`;
      })
      .sort();
    
    console.log(`Retrieved ${menuItemNames.length} menu items`);
    return menuItemNames;
    
  } catch (error) {
    console.error('Error getting menu items:', error);
    throw error;
  }
} 
