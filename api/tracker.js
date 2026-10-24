const axios = require('axios');

// In-memory state tracking to flag momentary hardware triggers
let lastMatchId = "";
let lastAcesCount = { p1: 0, p2: 0 };

module.exports = async (req, res) => {
  try {
    // 1. Fetch the raw internal data stream from Flashscore's endpoints
    // Mimics a standard browser agent to prevent IP flagging or access limits
    const response = await axios.get('https://flashscore.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'X-Fsign': 'SW9D1e1L' // Flashscore internal security verification signature token
      }
    });

    const rawData = response.data;
    if (!rawData || rawData.trim() === "") {
      return res.status(200).json({ live: false });
    }

    // 2. Parse Flashscore's text-delimited data packets
    // Flashscore uses custom separators (¬) instead of standard JSON structure for speeds
    const blocks = rawData.split('÷');
    let currentTournament = "";
    let liveMatches = [];

    blocks.forEach(block => {
      const lines = block.split('¬');
      let matchData = {};

      lines.forEach(line => {
        const key = line.substring(0, 2);
        const value = line.substring(3);

        if (key === 'TO') currentTournament = value; // Tournament Title Header
        if (key === 'AA') matchData.id = value;        // Unique Match ID
        if (key === 'AE') matchData.p1 = value;        // Player 1 Name
        if (key === 'AF') matchData.p2 = value;        // Player 2 Name
        if (key === 'GH') matchData.p1_sets = value;   // Player 1 Current Sets
        if (key === 'GI') matchData.p2_sets = value;   // Player 2 Current Sets
        if (key === 'AG') matchData.matchState = value;// Live point flag state
      });

      if (matchData.id && matchData.matchState === 'LIVE') {
        matchData.tournament = currentTournament;
        liveMatches.push(matchData);
      }
    });

    if (liveMatches.length === 0) {
      return res.status(200).json({ live: false });
    }

    // 3. Apply the Importance Priority Weights Matrix
    liveMatches.sort((a, b) => {
      const getWeight = (title) => {
        const t = title.toLowerCase();
        if (t.includes('wimbledon') || t.includes('open')) return 5; // Grand Slams
        if (t.includes('1000') || t.includes('masters')) return 4;   // ATP/WTA 1000
        if (t.includes('atp') || t.includes('wta')) return 3;       // Main Pro Tour
        if (t.includes('challenger')) return 2;                     // Sub-Pro Circuit
        return 1;                                                   // Juniors / ITF
      };
      return getWeight(b.tournament) - getWeight(a.tournament);
    });

    const bestMatch = liveMatches[0];

    // 4. Fetch Deep Live Statistics Sub-page for Ace Monitoring
    // Triggers a targeted lookup using the top-tier match ID found dynamically
    const statsResponse = await axios.get(`https://flashscore.com{bestMatch.id}_en_1`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    let p1Aces = 0, p2Aces = 0;
    const statsLines = statsResponse.data.split('¬');
    
    statsLines.forEach((line, index) => {
      if (line.includes('Aces')) {
        // Flashscore stores metric integers in subsequent lines relative to labels
        p1Aces = parseInt(statsLines[index + 1].replace(/\D/g, '')) || 0;
        p2Aces = parseInt(statsLines[index + 2].replace(/\D/g, '')) || 0;
      }
    });

    // 5. Calculate Real-Time Ace Transitions
    let aceDetected = 0;
    if (bestMatch.id === lastMatchId) {
      if (p1Aces > lastAcesCount.p1 || p2Aces > lastAcesCount.p2) {
        aceDetected = 1; // Ace detected!
      }
    }
    
    // Save current frame variables for next continuous evaluation loop
    lastMatchId = bestMatch.id;
    lastAcesCount = { p1: p1Aces, p2: p2Aces };

    // 6. Deliver the Clean, Compressed Data Array to your ESP32
    res.status(200).json({
      live: true,
      p1: bestMatch.p1,
      p2: bestMatch.p2,
      sets: `${bestMatch.p1_sets || 0}-${bestMatch.p2_sets || 0}`,
      finished: bestMatch.matchState === 'FINISHED' ? 1 : 0,
      aceEvent: aceDetected
    });

  } catch (error) {
    res.status(500).json({ error: "Flashscore data proxy failure" });
  }
};
