/* ==========================================================================
   bs.js — Black-Scholes 定价、希腊字母、盈亏计算引擎
   经典脚本(非 ES module),直接挂到 window.BS,因此 file:// 双击打开也能用。
   ========================================================================== */
(function (root) {
  'use strict';

  /* ---------- 正态分布 ---------- */

  // Abramowitz & Stegun 7.1.26,|误差| < 1.5e-7 —— 教学展示足够
  function erf(x) {
    var sign = x < 0 ? -1 : 1;
    var ax = Math.abs(x);
    var t = 1 / (1 + 0.3275911 * ax);
    var y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return sign * y;
  }

  // 标准正态累积分布函数 N(x)
  function normCdf(x) {
    return 0.5 * (1 + erf(x / Math.SQRT2));
  }

  // 标准正态概率密度函数 n(x)
  function normPdf(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }

  /* ---------- 工具 ---------- */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // 把"每单位标的"的盈亏换算到"每张合约"
  var DEFAULT_MULTIPLIER = 100;

  /* ---------- Black-Scholes ---------- */

  /**
   * 计算期权理论价与希腊字母。
   * @param {Object} p
   * @param {'call'|'put'} p.type
   * @param {number} p.S      标的现价
   * @param {number} p.K      行权价
   * @param {number} p.T      剩余时间(年)
   * @param {number} p.r      无风险利率(小数,如 0.02)
   * @param {number} p.sigma  年化波动率(小数,如 0.25)
   * @param {number} [p.q=0]  连续分红率
   */
  function price(p) {
    var type = p.type === 'put' ? 'put' : 'call';
    var S = Math.max(0, num(p.S, 0));
    var K = Math.max(0, num(p.K, 0));
    var T = Math.max(0, num(p.T, 0));
    var r = num(p.r, 0);
    var sigma = Math.max(0, num(p.sigma, 0));
    var q = num(p.q, 0);

    var df = Math.exp(-r * T);        // 折现因子
    var dq = Math.exp(-q * T);        // 分红折现因子

    // 内在价值:立刻行权能得到多少
    var intrinsic = type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);

    // 退化情形:已到期 / 波动率为 0 —— 价格等于(折现后的)内在价值
    if (T <= 1e-12 || sigma <= 1e-12) {
      var fwd = S * dq / df;                    // 远期价格
      var fwdIntrinsic = type === 'call' ? Math.max(fwd - K, 0) : Math.max(K - fwd, 0);
      var degenerate = fwdIntrinsic * df;
      var deltaDeg = type === 'call'
        ? (fwd > K ? dq : (fwd === K ? dq * 0.5 : 0))
        : (fwd < K ? -dq : (fwd === K ? -dq * 0.5 : 0));
      return {
        price: degenerate,
        intrinsic: intrinsic,
        timeValue: Math.max(degenerate - intrinsic, 0),
        delta: deltaDeg,
        gamma: 0, vega: 0, theta: 0, rho: 0,
        d1: NaN, d2: NaN,
        probITM: type === 'call' ? (fwd > K ? 1 : 0) : (fwd < K ? 1 : 0)
      };
    }

    var sqrtT = Math.sqrt(T);
    var volT = sigma * sqrtT;

    var d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / volT;
    var d2 = d1 - volT;

    var Nd1 = normCdf(d1);
    var Nd2 = normCdf(d2);
    var nd1 = normPdf(d1);

    var callPrice = S * dq * Nd1 - K * df * Nd2;
    var putPrice = K * df * (1 - Nd2) - S * dq * (1 - Nd1);

    var thePrice = type === 'call' ? callPrice : putPrice;

    // ---- 希腊字母 ----
    var delta, theta;

    if (type === 'call') {
      delta = dq * Nd1;
      // 每年;拆成"时间衰减"+"利息"+"分红"三项
      theta = -(S * dq * nd1 * sigma) / (2 * sqrtT)
        - r * K * df * Nd2
        + q * S * dq * Nd1;
    } else {
      delta = dq * (Nd1 - 1);
      theta = -(S * dq * nd1 * sigma) / (2 * sqrtT)
        + r * K * df * (1 - Nd2)
        - q * S * dq * (1 - Nd1);
    }

    var gamma = (dq * nd1) / (S * volT);
    var vega = S * dq * nd1 * sqrtT;              // 每 1.00(100%)波动率变化
    var rho = type === 'call'
      ? K * T * df * Nd2
      : -K * T * df * (1 - Nd2);

    return {
      price: Math.max(thePrice, 0),
      intrinsic: intrinsic,
      timeValue: Math.max(thePrice - intrinsic, 0),
      delta: delta,
      gamma: gamma,
      vega: vega,
      theta: theta,
      rho: rho,
      d1: d1,
      d2: d2,
      // 风险中性下到期为实值的概率
      probITM: type === 'call' ? Nd2 : (1 - Nd2)
    };
  }

  /**
   * 由市场价格反推隐含波动率。牛顿法 + 二分法兜底。
   */
  function impliedVol(targetPrice, p) {
    var S = num(p.S, 0), K = num(p.K, 0), T = num(p.T, 0);
    var r = num(p.r, 0), q = num(p.q, 0);
    var type = p.type === 'put' ? 'put' : 'call';
    if (!(targetPrice > 0) || T <= 0 || S <= 0 || K <= 0) return NaN;

    var intrinsic = type === 'call' ? Math.max(S * Math.exp(-q * T) - K * Math.exp(-r * T), 0)
      : Math.max(K * Math.exp(-r * T) - S * Math.exp(-q * T), 0);
    if (targetPrice < intrinsic - 1e-8) return NaN;   // 低于内在价值 → 无解(可能套利)

    var lo = 1e-6, hi = 5;   // 0.0001% ~ 500%
    var sigma = 0.3;         // 初值

    for (var i = 0; i < 60; i++) {
      var res = price({ type: type, S: S, K: K, T: T, r: r, q: q, sigma: sigma });
      var diff = res.price - targetPrice;
      if (Math.abs(diff) < 1e-8) return sigma;

      if (diff > 0) hi = Math.min(hi, sigma); else lo = Math.max(lo, sigma);

      var vega = res.vega;
      if (vega > 1e-8) {
        var next = sigma - diff / vega;
        // 牛顿步越界就退回二分
        sigma = (next > lo && next < hi) ? next : (lo + hi) / 2;
      } else {
        sigma = (lo + hi) / 2;
      }
      if (hi - lo < 1e-10) break;
    }
    return sigma;
  }

  /* ---------- 盈亏计算 ---------- */

  /**
   * 单条腿在到期日、标的价为 S 时的每单位盈亏(不含乘数)。
   * kind: 'call' | 'put' | 'stock'
   * dir:  +1 买入(long) / -1 卖出(short)
   */
  function legPayoff(leg, S) {
    var dir = leg.dir >= 0 ? 1 : -1;
    var prem = num(leg.premium, 0);
    var K = num(leg.K, 0);
    var intrinsic;

    if (leg.kind === 'stock') {
      // 股票的"权利金"就是建仓成本/卖价
      return dir === 1 ? (S - prem) : (prem - S);
    }
    if (leg.kind === 'put') {
      intrinsic = Math.max(K - S, 0);
    } else {
      intrinsic = Math.max(S - K, 0);
    }
    // 买方付出权利金,卖方收取权利金
    return dir === 1 ? (intrinsic - prem) : (prem - intrinsic);
  }

  /** 组合在标的价 S 处的总盈亏 */
  function payoffAt(legs, S) {
    var total = 0;
    for (var i = 0; i < legs.length; i++) {
      var qty = num(legs[i].qty, 1);
      total += legPayoff(legs[i], S) * qty;
    }
    return total;
  }

  /** 组合的净现金流:正=净收入(credit),负=净支出(debit) */
  function netPremium(legs) {
    var net = 0;
    for (var i = 0; i < legs.length; i++) {
      var leg = legs[i];
      var qty = num(leg.qty, 1);
      var dir = leg.dir >= 0 ? 1 : -1;
      // 买方支出 → 负数;卖方收入 → 正数
      net += -dir * num(leg.premium, 0) * qty;
    }
    return net;
  }

  /**
   * 在一段价格区间内扫描盈亏,得出:
   *  - 盈亏平衡点(近似到 step 精度后再线性细化)
   *  - 区间内的最大盈利 / 最大亏损
   *  - 曲线采样点
   */
  function analyze(legs, lo, hi, steps) {
    steps = steps || 600;
    var pts = [];
    var step = (hi - lo) / steps;
    var prevS = lo, prevV = payoffAt(legs, lo);
    pts.push({ S: lo, v: prevV });

    var breakevens = [];
    var maxV = prevV, minV = prevV;
    var maxAt = lo, minAt = lo;

    for (var i = 1; i <= steps; i++) {
      var S = lo + step * i;
      var v = payoffAt(legs, S);
      pts.push({ S: S, v: v });

      if (v > maxV) { maxV = v; maxAt = S; }
      if (v < minV) { minV = v; minAt = S; }

      // 穿越 0 → 线性插值求更精确的平衡点
      if ((prevV < 0 && v > 0) || (prevV > 0 && v < 0)) {
        var t = Math.abs(prevV) / (Math.abs(prevV) + Math.abs(v));
        breakevens.push({ S: prevS + (S - prevS) * t, from: prevV < 0 ? 'loss' : 'profit' });
      }
      if (v === 0 && prevV !== 0) breakevens.push({ S: S, from: prevV < 0 ? 'loss' : 'profit' });

      prevS = S; prevV = v;
    }

    return {
      points: pts,
      breakevens: breakevens,
      maxProfit: maxV, maxProfitAt: maxAt,
      maxLoss: minV, maxLossAt: minAt,
      range: { lo: lo, hi: hi }
    };
  }

  /**
   * 用解析方式求"到期日"的极值(考虑左右两端无穷远的行为)。
   * 返回 { maxProfit, maxLoss } —— null 表示无界。
   */
  function extremes(legs) {
    // 斜率的"上界"和"下界":S → +∞ 和 S → -∞ 时的每单位斜率
    var slopeUp = 0, slopeDown = 0;
    for (var i = 0; i < legs.length; i++) {
      var leg = legs[i], qty = num(leg.qty, 1);
      var dir = leg.dir >= 0 ? 1 : -1;
      if (leg.kind === 'call') { slopeUp += dir * qty; }
      else if (leg.kind === 'put') { slopeDown -= dir * qty; }
      else { slopeUp += dir * qty; slopeDown += dir * qty; }
    }

    // 在候选点集合上比较:S=0、各 K、以及各 K ± 一点
    var cands = [0];
    for (var j = 0; j < legs.length; j++) {
      if (legs[j].kind === 'stock') continue;
      var K = num(legs[j].K, 0);
      cands.push(K, Math.max(K - 0.01, 0), K + 0.01);
    }
    var maxV = -Infinity, minV = Infinity;
    for (var c = 0; c < cands.length; c++) {
      var v = payoffAt(legs, cands[c]);
      if (v > maxV) maxV = v;
      if (v < minV) minV = v;
    }

    return {
      // S → +∞ 时若斜率 > 0,盈利无上限
      maxProfit: slopeUp > 1e-9 ? Infinity : maxV,
      // S → +∞ 时若斜率 < 0,亏损无下限
      maxLoss: slopeUp < -1e-9 ? -Infinity : minV,
      slopeUp: slopeUp,
      slopeDown: slopeDown
    };
  }

  /* ---------- 小工具 ---------- */

  function num(v, dflt) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return isNum(n) ? n : (dflt === undefined ? 0 : dflt);
  }

  /** 把年化 theta 换成"每天" */
  function thetaPerDay(t) { return t / 365; }

  /** 把 vega 换成"波动率每变动 1 个百分点" */
  function vegaPerPct(v) { return v / 100; }

  /** 把 rho 换成"利率每变动 1 个百分点" */
  function rhoPerPct(v) { return v / 100; }

  var api = {
    erf: erf,
    normCdf: normCdf,
    normPdf: normPdf,
    price: price,
    impliedVol: impliedVol,
    legPayoff: legPayoff,
    payoffAt: payoffAt,
    netPremium: netPremium,
    analyze: analyze,
    extremes: extremes,
    thetaPerDay: thetaPerDay,
    vegaPerPct: vegaPerPct,
    rhoPerPct: rhoPerPct,
    clamp: clamp,
    DEFAULT_MULTIPLIER: DEFAULT_MULTIPLIER
  };

  root.BS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
