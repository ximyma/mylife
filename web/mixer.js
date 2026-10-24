/**
 * 混音器：朗读 + 背景氛围，带自动避让（ducking）。
 *
 * 为什么 BGM 是程序生成的，不是内置 mp3：
 *   ① 版权干净——自己算出来的波形，不会撞谁的曲子；
 *   ② 零体积——六套氛围加起来 0 字节，安装包不会因此胖 8MB；
 *   ③ 离线可用——不发请求，山里也能响；
 *   ④ 好混音——全是 Web Audio 节点，朗读一响就把 BGM 压下去，句间再抬回来。
 *
 * 说实话：它是"氛围垫"，不是唱片。当朗读的底足够，当主角不够。
 */
(function () {
  'use strict';

  var ac = null;          // AudioContext
  var master = null;      // 总音量
  var bgmGain = null;     // 背景音量（ducking 改的就是它）
  var voiceGain = null;   // 朗读音量（留给将来把 <audio> 接进来）
  var timer = null;
  var step = 0;
  var playing = false;
  var presetKey = 'none';
  var volume = 0.34;
  var ducked = false;

  /* 六套氛围：只差在和弦、音色与速度。
     半音偏移以 A3(220Hz) 为基准，正数是升。 */
  var PRESETS = {
    none: { n: '不配乐', short: '无' },
    piano: {
      n: '旧钢琴', short: '琴', tempo: 54, wave: 'triangle',
      prog: [[0, 4, 7], [-3, 2, 5], [5, 9, 12], [-5, 0, 4]],
      oct: 0, att: 0.01, dec: 2.6, gain: 0.22, arp: true,
    },
    harmonica: {
      n: '口琴', short: '琴', tempo: 46, wave: 'sine',
      prog: [[0, 3, 7], [2, 5, 9], [-3, 0, 4], [-5, -2, 2]],
      oct: 12, att: 0.08, dec: 3.4, gain: 0.16, vibrato: 5,
    },
    guitar: {
      n: '民谣吉他', short: '吉', tempo: 62, wave: 'sawtooth',
      prog: [[0, 4, 7], [7, 11, 14], [5, 9, 12], [-3, 0, 4]],
      oct: 0, att: 0.01, dec: 1.6, gain: 0.13, lowpass: 1800, arp: true,
    },
    strings: {
      n: '弦乐', short: '弦', tempo: 38, wave: 'sawtooth',
      prog: [[0, 4, 7, 11], [-3, 0, 4, 7], [5, 9, 12, 16], [2, 5, 9, 12]],
      oct: -12, att: 0.9, dec: 4.2, gain: 0.10, lowpass: 1200,
    },
    vinyl: {
      n: '老唱片', short: '片', tempo: 44, wave: 'sine',
      prog: [[0, 4, 7], [-3, 2, 5], [2, 5, 9], [-5, 0, 4]],
      oct: 0, att: 0.3, dec: 3.8, gain: 0.12, noise: 0.012, wow: 0.6,
    },
    bright: {
      n: '轻快', short: '快', tempo: 84, wave: 'square',
      prog: [[0, 4, 7], [2, 5, 9], [4, 7, 11], [-1, 2, 7]],
      oct: 12, att: 0.01, dec: 1.0, gain: 0.08, lowpass: 2400, arp: true,
    },
  };

  function ensure() {
    if (ac) return true;
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return false;
    try { ac = new C(); } catch (e) { return false; }
    master = ac.createGain();
    master.gain.value = volume;
    master.connect(ac.destination);

    bgmGain = ac.createGain();
    bgmGain.gain.value = 0.34;
    bgmGain.connect(master);

    voiceGain = ac.createGain();
    voiceGain.gain.value = 1;
    voiceGain.connect(master);

    // 一点回声，让单薄的合成音不那么干
    try {
      var delay = ac.createDelay(0.6);
      delay.delayTime.value = 0.28;
      var fb = ac.createGain();
      fb.gain.value = 0.22;
      var wet = ac.createGain();
      wet.gain.value = 0.30;
      delay.connect(fb); fb.connect(delay);
      delay.connect(wet); wet.connect(master);
      bgmGain.connect(delay);
    } catch (e) {}

    return true;
  }

  function freq(semi, oct) {
    return 220 * Math.pow(2, (semi + (oct || 0)) / 12);
  }

  function note(p, semi, when, dur, gain) {
    var o = ac.createOscillator();
    var g = ac.createGain();
    o.type = p.wave || 'sine';
    o.frequency.value = freq(semi, p.oct);

    // 老唱片的轻微走音：慢速调制频率
    if (p.wow) {
      var lfo = ac.createOscillator();
      var lg = ac.createGain();
      lfo.frequency.value = 0.5;
      lg.gain.value = p.wow;
      lfo.connect(lg); lg.connect(o.frequency);
      lfo.start(when); lfo.stop(when + dur + 0.2);
    }
    // 口琴的颤音
    if (p.vibrato) {
      var v = ac.createOscillator();
      var vg = ac.createGain();
      v.frequency.value = p.vibrato;
      vg.gain.value = 2.2;
      v.connect(vg); vg.connect(o.frequency);
      v.start(when); v.stop(when + dur + 0.2);
    }

    var node = o;
    if (p.lowpass) {
      var f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = p.lowpass;
      o.connect(f); node = f;
    }

    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), when + (p.att || 0.02));
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    node.connect(g);
    g.connect(bgmGain);
    o.start(when);
    o.stop(when + dur + 0.05);
  }

  function tick() {
    var p = PRESETS[presetKey];
    if (!p || presetKey === 'none') return;
    var chord = p.prog[step % p.prog.length];
    var now = ac.currentTime + 0.02;
    var beat = 60 / p.tempo;

    for (var i = 0; i < chord.length; i++) {
      note(p, chord[i], now + i * (p.arp ? beat * 0.16 : 0.01), p.dec, p.gain);
    }
    // 低音铺底
    note(p, chord[0] - 12, now, p.dec * 1.2, (p.gain || 0.15) * 0.55);

    if (p.noise) {
      try {
        var buf = ac.createBuffer(1, ac.sampleRate * 1.2, ac.sampleRate);
        var d = buf.getChannelData(0);
        for (var k = 0; k < d.length; k++) d[k] = (Math.random() * 2 - 1) * 0.5;
        var src = ac.createBufferSource();
        var ng = ac.createGain();
        var lp = ac.createBiquadFilter();
        lp.type = 'bandpass';
        lp.frequency.value = 2600;
        ng.gain.value = p.noise;
        src.buffer = buf;
        src.connect(lp); lp.connect(ng); ng.connect(bgmGain);
        src.start(now);
      } catch (e) {}
    }

    step++;
    timer = setTimeout(tick, beat * 1000 * (p.arp ? 4 : 2));
  }

  function ramp(to, sec) {
    if (!bgmGain) return;
    var t = ac.currentTime;
    try {
      bgmGain.gain.cancelScheduledValues(t);
      bgmGain.gain.setValueAtTime(bgmGain.gain.value, t);
      bgmGain.gain.linearRampToValueAtTime(to, t + (sec || 0.35));
    } catch (e) { bgmGain.gain.value = to; }
  }

  window.Mixer = {
    presets: function () {
      var out = [];
      for (var k in PRESETS) if (Object.prototype.hasOwnProperty.call(PRESETS, k)) {
        out.push({ k: k, n: PRESETS[k].n, short: PRESETS[k].short });
      }
      return out;
    },

    /** 选一套氛围；正在播就立刻换 */
    setPreset: function (k) {
      presetKey = PRESETS[k] ? k : 'none';
      try { localStorage.setItem('ms_bgm', presetKey); } catch (e) {}
      if (playing) { this.stop(); this.start(); }
      return presetKey;
    },

    current: function () { return presetKey; },

    start: function () {
      if (presetKey === 'none') return false;
      if (!ensure()) return false;
      if (ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
      if (playing) return true;
      playing = true;
      step = 0;
      tick();
      return true;
    },

    stop: function () {
      playing = false;
      if (timer) { clearTimeout(timer); timer = null; }
    },

    isOn: function () { return playing; },

    setVolume: function (v) {
      volume = Math.max(0, Math.min(1, Number(v) || 0));
      if (master) master.gain.value = volume;
      try { localStorage.setItem('ms_bgm_vol', String(volume)); } catch (e) {}
    },

    /** 朗读时压低 BGM，句间抬回 */
    duck: function (on) {
      if (!bgmGain) return;
      if (on === ducked) return;
      ducked = !!on;
      ramp(ducked ? 0.09 : 0.34, ducked ? 0.25 : 0.6);
    },

    /** 页面加载时恢复上次选的氛围与音量 */
    restore: function () {
      try {
        var k = localStorage.getItem('ms_bgm');
        if (k && PRESETS[k]) presetKey = k;
        var v = Number(localStorage.getItem('ms_bgm_vol'));
        if (v > 0) volume = v;
      } catch (e) {}
      if (master) master.gain.value = volume;
      return { preset: presetKey, volume: volume };
    },
  };
})();
