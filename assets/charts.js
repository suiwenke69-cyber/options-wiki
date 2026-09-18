/* ==========================================================================
   charts.js — Canvas 图表引擎(零依赖)
   提供两类图:
     Charts.payoff() 到期盈亏图(带盈利/亏损分区填充、平衡点、行权价标记)
     Charts.lines()  通用多序列折线图(用于希腊字母、时间衰减、波动率等)
   经典脚本,挂到 window.Charts。
   ========================================================================== */
(function (root) {
  'use strict';

  // 回退值(浅色主题)。实际取色优先读 CSS 令牌,因此图表自动跟随主题切换。
  var FALLBACK = {
    profit: '#0f8a4d',
    profitFill: 'rgba(15, 138, 77, .13)',
    loss: '#cf2b2b',
    lossFill: 'rgba(207, 43, 43, .13)',
    accent: '#1d4ed8',
    accentSoft: 'rgba(29, 78, 216, .10)',
    gold: '#a9750f',
    purple: '#7c3aed',
    teal: '#0d7490',
    orange: '#c2410c',
    ink: '#3d4653',
    ink2: '#3d4653',
    ink3: '#98a0ab',
    ink4: '#98a0ab',
    grid: '#e5e1d9',
    gridMajor: '#d2cdc2',
    zero: '#8a929c',
    card: '#ffffff'
  };

  // 调色板键 → CSS 自定义属性
  var VAR_MAP = {
    profit: '--profit', profitFill: '--profit-fill',
    loss: '--loss', lossFill: '--loss-fill',
    accent: '--accent', accentSoft: '--accent-fill',
    gold: '--gold',
    ink: '--chart-ink', ink2: '--chart-ink',
    ink3: '--chart-label', ink4: '--chart-label',
    grid: '--chart-grid', gridMajor: '--chart-gridmajor',
    zero: '--chart-label', card: '--chart-surface'
  };

  function cssVar(name) {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch (e) { return ''; }
  }

  // 读取时即时解析,所以每次重绘都会取到当前主题的颜色
  var PALETTE = new Proxy(FALLBACK, {
    get: function (target, key) {
      var varName = VAR_MAP[key];
      if (varName) {
        var v = cssVar(varName);
        if (v) return v;
      }
      return target[key];
    }
  });

  var FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

  /* ---------- 画布准备(HiDPI) ---------- */

  function prep(canvas, height) {
    var dpr = Math.min(root.devicePixelRatio || 1, 2);
    var cssW = canvas.clientWidth;
    if (!cssW && canvas.parentElement) cssW = canvas.parentElement.clientWidth - 20;
    if (!cssW || cssW < 40) cssW = 640;

    canvas.style.height = height + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(height * dpr);

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, height);
    ctx.font = '12px ' + FONT;
    return { ctx: ctx, w: cssW, h: height };
  }

  /* ---------- 刻度 ---------- */

  function niceStep(range, target) {
    if (!(range > 0)) return 1;
    var raw = range / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return mult * mag;
  }

  function ticksFor(lo, hi, target) {
    var step = niceStep(hi - lo, target || 5);
    var out = [];
    var start = Math.ceil(lo / step) * step;
    for (var v = start; v <= hi + step * 1e-6; v += step) {
      out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return { ticks: out, step: step };
  }

  function decimalsFor(step) {
    if (!(step > 0)) return 0;
    var d = Math.ceil(-Math.log10(step));
    return Math.max(0, Math.min(6, d));
  }

  function fmt(v, d) {
    if (!isFinite(v)) return v > 0 ? '∞' : '-∞';
    return v.toFixed(d === undefined ? 2 : d);
  }

  function fmtCompact(v, d) {
    if (Math.abs(v) >= 10000) return (v / 1000).toFixed(1) + 'k';
    return fmt(v, d);
  }

  /* ---------- 绘图原语 ---------- */

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function label(ctx, text, x, y, opts) {
    opts = opts || {};
    ctx.save();
    ctx.font = (opts.weight || '500') + ' ' + (opts.size || 12) + 'px ' + FONT;
    ctx.fillStyle = opts.color || PALETTE.ink3;
    ctx.textAlign = opts.align || 'left';
    ctx.textBaseline = opts.baseline || 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function chip(ctx, text, x, y, bg, fg, align) {
    ctx.save();
    ctx.font = '600 11.5px ' + FONT;
    var padX = 6, h = 18;
    var w = ctx.measureText(text).width + padX * 2;
    var bx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    roundRect(ctx, bx, y - h / 2, w, h, 5);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + padX, y + 0.5);
    ctx.restore();
    return w;
  }

  /* ---------- 坐标轴 ---------- */

  function buildGeom(w, h, xLo, xHi, yLo, yHi, pad) {
    pad = pad || {};
    var p = {
      l: pad.l === undefined ? 62 : pad.l,
      r: pad.r === undefined ? 18 : pad.r,
      t: pad.t === undefined ? 18 : pad.t,
      b: pad.b === undefined ? 36 : pad.b
    };
    var iw = w - p.l - p.r;
    var ih = h - p.t - p.b;
    if (xHi === xLo) xHi = xLo + 1;
    if (yHi === yLo) yHi = yLo + 1;
    return {
      pad: p, iw: iw, ih: ih, w: w, h: h,
      xLo: xLo, xHi: xHi, yLo: yLo, yHi: yHi,
      X: function (v) { return p.l + (v - xLo) / (xHi - xLo) * iw; },
      Y: function (v) { return p.t + (yHi - v) / (yHi - yLo) * ih; },
      invX: function (px) { return xLo + (px - p.l) / iw * (xHi - xLo); }
    };
  }

  function drawAxes(ctx, g, opts) {
    opts = opts || {};
    var xr = ticksFor(g.xLo, g.xHi, opts.xCount || 6);
    var yr = ticksFor(g.yLo, g.yHi, opts.yCount || 5);
    var xd = decimalsFor(xr.step);
    var yd = decimalsFor(yr.step);

    ctx.save();
    ctx.lineWidth = 1;

    // 横向网格 + y 轴标签
    ctx.strokeStyle = PALETTE.grid;
    ctx.beginPath();
    for (var i = 0; i < yr.ticks.length; i++) {
      var yy = Math.round(g.Y(yr.ticks[i])) + 0.5;
      ctx.moveTo(g.pad.l, yy);
      ctx.lineTo(g.pad.l + g.iw, yy);
    }
    ctx.stroke();
    for (var j = 0; j < yr.ticks.length; j++) {
      label(ctx, fmtCompact(yr.ticks[j], yd), g.pad.l - 9, g.Y(yr.ticks[j]),
        { align: 'right', color: PALETTE.ink4, size: 11.5 });
    }

    // x 轴标签
    for (var k = 0; k < xr.ticks.length; k++) {
      label(ctx, fmtCompact(xr.ticks[k], xd), g.X(xr.ticks[k]), g.pad.t + g.ih + 17,
        { align: 'center', color: PALETTE.ink4, size: 11.5 });
    }

    // 轴线
    ctx.strokeStyle = PALETTE.gridMajor;
    ctx.beginPath();
    ctx.moveTo(g.pad.l + 0.5, g.pad.t);
    ctx.lineTo(g.pad.l + 0.5, g.pad.t + g.ih + 0.5);
    ctx.lineTo(g.pad.l + g.iw, g.pad.t + g.ih + 0.5);
    ctx.stroke();

    if (opts.xLabel) label(ctx, opts.xLabel, g.pad.l + g.iw / 2, g.h - 6, { align: 'center', color: PALETTE.ink3, size: 12, weight: '600' });
    if (opts.yLabel) {
      ctx.save();
      ctx.translate(13, g.pad.t + g.ih / 2);
      ctx.rotate(-Math.PI / 2);
      label(ctx, opts.yLabel, 0, 0, { align: 'center', color: PALETTE.ink3, size: 12, weight: '600' });
      ctx.restore();
    }
    ctx.restore();
  }

  /* ---------- 线/参考线 ---------- */

  function vline(ctx, g, v, opts) {
    opts = opts || {};
    var x = g.X(v);
    if (x < g.pad.l - 1 || x > g.pad.l + g.iw + 1) return;
    ctx.save();
    ctx.strokeStyle = opts.color || PALETTE.ink4;
    ctx.lineWidth = opts.width || 1;
    ctx.setLineDash(opts.dash || [3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, g.pad.t);
    ctx.lineTo(Math.round(x) + 0.5, g.pad.t + g.ih);
    ctx.stroke();
    ctx.restore();
    if (opts.label) {
      chip(ctx, opts.label, x, g.pad.t + 9, opts.color || PALETTE.ink4, '#fff', 'center');
    }
  }

  function hline(ctx, g, v, opts) {
    opts = opts || {};
    var y = g.Y(v);
    ctx.save();
    ctx.strokeStyle = opts.color || PALETTE.ink4;
    ctx.lineWidth = opts.width || 1;
    ctx.setLineDash(opts.dash || []) ;
    ctx.beginPath();
    ctx.moveTo(g.pad.l, Math.round(y) + 0.5);
    ctx.lineTo(g.pad.l + g.iw, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
    if (opts.label) {
      ctx.save();
      ctx.font = '600 11.5px ' + FONT;
      var w = ctx.measureText(opts.label).width + 12;
      chip(ctx, opts.label, g.pad.l + g.iw - w - 2, y - 10, opts.bg || PALETTE.accentSoft, opts.color || PALETTE.accent, 'left');
      ctx.restore();
    }
  }

  /* ---------- 到期盈亏图 ---------- */

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} cfg
   *   legs        [{kind,dir,K,premium,qty}]
   *   spot        当前标的价
   *   lo, hi      x 轴范围
   *   showNow     是否叠加"当前(未到期)盈亏"曲线
   *   remainingT  当前曲线的剩余年限
   *   r, sigma    当前曲线所需参数
   *   height      画布高度
   *   multiplier  每张合约乘数(默认100)
   *   marks       额外的参考线 [{v,label,color}]
   */
  function payoff(canvas, cfg) {
    var H = cfg.height || 400;
    var s = prep(canvas, H);
    var ctx = s.ctx, w = s.w, h = s.h;
    var legs = cfg.legs || [];
    var lo = cfg.lo, hi = cfg.hi;
    var res = root.BS.analyze(legs, lo, hi, 700);

    // y 轴范围:兼顾到期曲线与"当前"曲线
    var yLo = res.maxLoss, yHi = res.maxProfit;
    var nowPts = null;
    if (cfg.showNow && cfg.remainingT > 0) {
      nowPts = [];
      for (var i = 0; i <= 240; i++) {
        var S = lo + (hi - lo) * i / 240;
        nowPts.push({ S: S, v: theoreticalPL(legs, S, cfg) });
      }
      for (var m = 0; m < nowPts.length; m++) {
        if (nowPts[m].v > yHi) yHi = nowPts[m].v;
        if (nowPts[m].v < yLo) yLo = nowPts[m].v;
      }
    }

    if (!isFinite(yLo)) yLo = yHi - 10;
    if (!isFinite(yHi)) yHi = yLo + 10;
    var padY = (yHi - yLo) * 0.14 || 1;
    yLo -= padY; yHi += padY;
    if (yLo > 0) yLo = 0;
    if (yHi < 0) yHi = 0;

    var g = buildGeom(w, h, lo, hi, yLo, yHi, { l: 66, r: 20, t: 20, b: 38 });

    drawAxes(ctx, g, { xLabel: '到期时标的价', yLabel: '每张合约盈亏', xCount: 6, yCount: 5 });

    var zeroY = g.Y(0);

    // ---- 盈利/亏损分区填充 ----
    var area = function () {
      ctx.beginPath();
      ctx.moveTo(g.X(res.points[0].S), zeroY);
      for (var i = 0; i < res.points.length; i++) ctx.lineTo(g.X(res.points[i].S), g.Y(res.points[i].v));
      ctx.lineTo(g.X(res.points[res.points.length - 1].S), zeroY);
      ctx.closePath();
    };

    ctx.save();
    ctx.beginPath(); ctx.rect(g.pad.l, g.pad.t, g.iw, Math.max(0, zeroY - g.pad.t)); ctx.clip();
    area(); ctx.fillStyle = PALETTE.profitFill; ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath(); ctx.rect(g.pad.l, zeroY, g.iw, Math.max(0, g.pad.t + g.ih - zeroY)); ctx.clip();
    area(); ctx.fillStyle = PALETTE.lossFill; ctx.fill();
    ctx.restore();

    // ---- 零轴 ----
    hline(ctx, g, 0, { color: PALETTE.zero, width: 1.4, dash: [] });

    // ---- 行权价参考线 ----
    for (var a = 0; a < legs.length; a++) {
      if (legs[a].kind === 'stock') continue;
      vline(ctx, g, legs[a].K, { color: PALETTE.ink4, dash: [2, 3], label: 'K=' + trimNum(legs[a].K) });
    }
    (cfg.marks || []).forEach(function (mk) {
      vline(ctx, g, mk.v, { color: mk.color || PALETTE.gold, dash: [4, 3], label: mk.label });
    });

    // ---- "当前(未到期)"曲线 ----
    if (nowPts) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(g.pad.l, g.pad.t, g.iw, g.ih);
      ctx.clip();
      ctx.strokeStyle = PALETTE.accent;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      for (var n = 0; n < nowPts.length; n++) {
        var px = g.X(nowPts[n].S), py = g.Y(nowPts[n].v);
        if (n === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ---- 到期曲线(按盈亏双色描边) ----
    var strokeCurve = function () {
      ctx.beginPath();
      for (var i = 0; i < res.points.length; i++) {
        var px = g.X(res.points[i].S), py = g.Y(res.points[i].v);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    };
    ctx.save();
    ctx.lineWidth = 2.6;
    ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.rect(g.pad.l, g.pad.t, g.iw, Math.max(0, zeroY - g.pad.t)); ctx.clip();
    ctx.strokeStyle = PALETTE.profit; strokeCurve();
    ctx.restore();

    ctx.save();
    ctx.lineWidth = 2.6;
    ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.rect(g.pad.l, zeroY, g.iw, Math.max(0, g.pad.t + g.ih - zeroY)); ctx.clip();
    ctx.strokeStyle = PALETTE.loss; strokeCurve();
    ctx.restore();

    // ---- 现价标记 ----
    if (isFinite(cfg.spot)) {
      vline(ctx, g, cfg.spot, { color: PALETTE.ink, dash: [], width: 1.6, label: '现价 ' + trimNum(cfg.spot) });
    }

    // ---- 盈亏平衡点 ----
    for (var b = 0; b < res.breakevens.length; b++) {
      var bx = g.X(res.breakevens[b].S);
      if (bx < g.pad.l || bx > g.pad.l + g.iw) continue;
      ctx.save();
      ctx.beginPath();
      ctx.arc(bx, zeroY, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = PALETTE.ink2;
      ctx.stroke();
      ctx.restore();
      chip(ctx, '平衡 ' + trimNum(res.breakevens[b].S), bx, zeroY + (res.breakevens[b].from === 'loss' ? 30 : -30),
        PALETTE.ink, '#fff', 'center');
    }

    return {
      analysis: res,
      maxProfit: res.maxProfit, maxLoss: res.maxLoss,
      breakevens: res.breakevens.map(function (x) { return x.S; }),
      geom: g
    };
  }

  /** 若期权尚未到期,组合在标的价 S 处的浮动盈亏(用 BS 理论价) */
  function theoreticalPL(legs, S, cfg) {
    var t = cfg.remainingT;
    var total = 0;
    for (var i = 0; i < legs.length; i++) {
      var leg = legs[i];
      var qty = leg.qty === undefined ? 1 : leg.qty;
      var dir = leg.dir >= 0 ? 1 : -1;
      var val;
      if (leg.kind === 'stock') {
        val = S;
      } else {
        val = root.BS.price({
          type: leg.kind, S: S, K: leg.K, T: t,
          r: cfg.r === undefined ? 0.02 : cfg.r,
          sigma: cfg.sigma === undefined ? 0.25 : cfg.sigma
        }).price;
      }
      // 买方:现值 - 成本;卖方:权利金 - 现值
      total += (dir === 1 ? (val - leg.premium) : (leg.premium - val)) * qty;
    }
    return total;
  }

  function trimNum(v) {
    if (!isFinite(v)) return String(v);
    var r = Math.round(v * 100) / 100;
    return String(r);
  }

  /* ---------- 通用折线图 ---------- */

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} cfg
   *   series  [{name, color, points:[[x,y]...], width, dash, fill, areaTo}]
   *   xLo,xHi,yLo,yHi  (缺省时自动)
   *   xLabel,yLabel
   *   vlines, hlines, markers
   *   xFmt, yFmt  自定义格式化函数
   *   legend      true 时画图例
   */
  function lines(canvas, cfg) {
    var H = cfg.height || 300;
    var s = prep(canvas, H);
    var ctx = s.ctx, w = s.w, h = s.h;
    var series = (cfg.series || []).filter(function (x) { return x.points && x.points.length; });
    if (!series.length) return null;

    // 自动范围
    var xLo = cfg.xLo, xHi = cfg.xHi, yLo = cfg.yLo, yHi = cfg.yHi;
    var all = [];
    series.forEach(function (se) { all = all.concat(se.points); });
    if (xLo === undefined) xLo = Math.min.apply(null, all.map(function (p) { return p[0]; }));
    if (xHi === undefined) xHi = Math.max.apply(null, all.map(function (p) { return p[0]; }));
    if (yLo === undefined) yLo = Math.min.apply(null, all.map(function (p) { return p[1]; }));
    if (yHi === undefined) yHi = Math.max.apply(null, all.map(function (p) { return p[1]; }));
    (cfg.hlines || []).forEach(function (hl) {
      if (hl.v < yLo) yLo = hl.v;
      if (hl.v > yHi) yHi = hl.v;
    });
    if (cfg.includeZero) { if (yLo > 0) yLo = 0; if (yHi < 0) yHi = 0; }

    var padY = (yHi - yLo) * 0.1;
    if (padY === 0) padY = Math.abs(yHi) * 0.1 || 1;
    yLo -= padY; yHi += padY;

    var g = buildGeom(w, h, xLo, xHi, yLo, yHi, cfg.pad || { l: 66, r: 20, t: 18, b: 38 });
    drawAxes(ctx, g, { xLabel: cfg.xLabel, yLabel: cfg.yLabel, xCount: cfg.xCount || 6, yCount: cfg.yCount || 5 });

    var xd = cfg.xFmt || function (v) { return fmtCompact(v, 0); };
    var yd = cfg.yFmt || function (v) { return fmtCompact(v, 2); };

    // 竖直参考线
    (cfg.vlines || []).forEach(function (vl) {
      vline(ctx, g, vl.v, { color: vl.color || PALETTE.ink4, dash: vl.dash || [3, 3], label: vl.label });
    });

    ctx.save();
    ctx.beginPath(); ctx.rect(g.pad.l, g.pad.t, g.iw, g.ih); ctx.clip();

    series.forEach(function (se) {
      // 面积填充
      if (se.fill) {
        ctx.beginPath();
        ctx.moveTo(g.X(se.points[0][0]), g.Y(se.areaTo === undefined ? 0 : se.areaTo));
        se.points.forEach(function (p) { ctx.lineTo(g.X(p[0]), g.Y(p[1])); });
        ctx.lineTo(g.X(se.points[se.points.length - 1][0]), g.Y(se.areaTo === undefined ? 0 : se.areaTo));
        ctx.closePath();
        ctx.fillStyle = se.fill;
        ctx.fill();
      }
      // 线条
      ctx.beginPath();
      se.points.forEach(function (p, i) {
        var px = g.X(p[0]), py = g.Y(p[1]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = se.color || PALETTE.accent;
      ctx.lineWidth = se.width || 2.2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(se.dash || []);
      ctx.stroke();
      ctx.setLineDash([]);

      // 端点圆点
      if (se.dots) {
        se.points.forEach(function (p) {
          if (!p[2]) return;
          ctx.beginPath();
          ctx.arc(g.X(p[0]), g.Y(p[1]), 3.6, 0, Math.PI * 2);
          ctx.fillStyle = '#fff'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = se.color || PALETTE.accent; ctx.stroke();
        });
      }
    });
    ctx.restore();

    // 水平参考线
    (cfg.hlines || []).forEach(function (hl) {
      hline(ctx, g, hl.v, hl);
    });

    // 标记点 + 竖线
    (cfg.markers || []).forEach(function (mk) {
      var px = g.X(mk.x), py = g.Y(mk.y);
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = mk.color || PALETTE.accent;
      ctx.fill();
      ctx.lineWidth = 2.4; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.restore();
      if (mk.label) {
        var above = py > g.pad.t + 34;
        chip(ctx, mk.label, px, py + (above ? -19 : 19), mk.color || PALETTE.accent, '#fff', 'center');
      }
    });

    // x 轴标签覆盖(需要自定义格式时)
    if (cfg.xFmt) {
      // 已由 drawAxes 用默认格式绘制,这里重绘一层以应用自定义格式
      ctx.save();
      ctx.fillStyle = PALETTE.card;
      ctx.fillRect(g.pad.l, g.pad.t + g.ih + 1, g.iw, g.pad.b - 1);
      var xr = ticksFor(g.xLo, g.xHi, cfg.xCount || 6);
      xr.ticks.forEach(function (t) {
        label(ctx, xd(t), g.X(t), g.pad.t + g.ih + 17, { align: 'center', color: PALETTE.ink4, size: 11.5 });
      });
      ctx.restore();
    }
    if (cfg.yFmt) {
      ctx.save();
      ctx.fillStyle = PALETTE.card;
      ctx.fillRect(0, g.pad.t - 4, g.pad.l - 2, g.ih + 8);
      var yr = ticksFor(g.yLo, g.yHi, cfg.yCount || 5);
      yr.ticks.forEach(function (t) {
        label(ctx, yd(t), g.pad.l - 9, g.Y(t), { align: 'right', color: PALETTE.ink4, size: 11.5 });
      });
      ctx.restore();
    }

    return { geom: g };
  }

  /* ---------- 自动重绘 ---------- */

  var registry = new WeakMap();

  /** 把画布与它的渲染函数绑定;容器尺寸变化时自动重绘 */
  function bind(canvas, render) {
    registry.set(canvas, render);
    if (!bind._installed && root.ResizeObserver) {
      bind._installed = true;
      if (!bind._ro) {
        bind._ro = new ResizeObserver(function (entries) {
          entries.forEach(function (e) {
            var c = e.target.querySelector ? e.target.querySelector('canvas') : null;
            if (c && registry.has(c)) schedule(c);
          });
        });
      }
    }
    if (root.ResizeObserver && canvas.parentElement && bind._ro && !canvas.parentElement.__dshObserved) {
      canvas.parentElement.__dshObserved = true;
      bind._ro.observe(canvas.parentElement);
    }
    if (!bind._win && root.addEventListener) {
      bind._win = true;
      var t = null;
      root.addEventListener('resize', function () {
        clearTimeout(t);
        t = setTimeout(function () {
          registry.forEach ? null : null;
          document.querySelectorAll('canvas').forEach(function (c) {
            if (registry.has(c)) schedule(c);
          });
        }, 140);
      });
    }
    render();
  }

  function schedule(canvas) {
    if (canvas.__dshRaf) cancelAnimationFrame(canvas.__dshRaf);
    canvas.__dshRaf = requestAnimationFrame(function () {
      canvas.__dshRaf = null;
      var fn = registry.get(canvas);
      if (fn) { try { fn(); } catch (err) { console.error('[charts] redraw failed', err); } }
    });
  }

  /** 主题切换后重绘所有已绑定的画布 */
  function redrawAll() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('canvas').forEach(function (c) {
      if (registry.has(c)) schedule(c);
    });
  }

  root.Charts = {
    PALETTE: PALETTE,
    payoff: payoff,
    lines: lines,
    bind: bind,
    redrawAll: redrawAll,
    theoreticalPL: theoreticalPL,
    fmt: fmt
  };
})(typeof window !== 'undefined' ? window : globalThis);
