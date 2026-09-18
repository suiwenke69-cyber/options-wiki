/* ==========================================================================
   site.js — 全站交互:导航、页内目录、滚动高亮、测验引擎、数值格式化
   经典脚本,挂到 window.Site。
   ========================================================================== */
(function (root, doc) {
  'use strict';

  /* ---------- 数值格式化 ---------- */

  function n(v, d) {
    var x = typeof v === 'string' ? parseFloat(v) : v;
    if (typeof x !== 'number' || !isFinite(x)) return '—';
    return x.toFixed(d === undefined ? 2 : d);
  }

  /** 金额,带千分位 */
  function money(v, d) {
    var x = typeof v === 'string' ? parseFloat(v) : v;
    if (typeof x !== 'number' || !isFinite(x)) return x > 0 ? '∞' : '-∞';
    var s = Math.abs(x).toFixed(d === undefined ? 0 : d);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (x < 0 ? '-' : '') + parts.join('.');
  }

  /** 带正负号的金额 */
  function signed(v, d) {
    var x = typeof v === 'string' ? parseFloat(v) : v;
    if (!isFinite(x)) return x > 0 ? '+∞' : '-∞';
    return (x > 0 ? '+' : '') + money(x, d);
  }

  /** 小数 → 百分比字符串 */
  function pct(v, d) {
    var x = typeof v === 'string' ? parseFloat(v) : v;
    if (!isFinite(x)) return '—';
    return (x * 100).toFixed(d === undefined ? 1 : d) + '%';
  }

  function signedPct(v, d) {
    var x = typeof v === 'string' ? parseFloat(v) : v;
    if (!isFinite(x)) return '—';
    return (x > 0 ? '+' : '') + (x * 100).toFixed(d === undefined ? 1 : d) + '%';
  }

  /** 按正负给 CSS 类(红=盈利,绿=亏损) */
  function plClass(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted'; }

  /** 把 -Infinity / Infinity 显示成友好文字 */
  function orInf(v, suffix) {
    if (v === Infinity) return '无上限' + (suffix || '');
    if (v === -Infinity) return '无下限' + (suffix || '');
    return null;
  }

  /* ---------- 顶栏导航 ---------- */

  function initNav() {
    var topbar = doc.querySelector('.topbar');
    var toggle = doc.querySelector('.navtoggle');
    if (topbar && toggle) {
      toggle.addEventListener('click', function () {
        var open = topbar.classList.toggle('navopen');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      doc.addEventListener('click', function (e) {
        if (!topbar.contains(e.target)) {
          topbar.classList.remove('navopen');
          toggle.setAttribute('aria-expanded', 'false');
        }
      });
    }

    // 高亮当前页
    var here = location.pathname.split('/').pop() || 'index.html';
    doc.querySelectorAll('.sitenav a').forEach(function (a) {
      var href = a.getAttribute('href');
      if (!href) return;
      if (href === here || (here === '' && href === 'index.html')) {
        a.setAttribute('aria-current', 'page');
      }
    });
  }

  /* ---------- 页内目录 + 滚动高亮 ---------- */

  function initToc() {
    var aside = doc.querySelector('[data-toc]');
    var prose = doc.querySelector('.prose');
    if (!aside || !prose) return;

    // 卡片内的标题(.card__title)在语义上是 h3,但不进目录,避免目录被碎片标题淹没
    var heads = Array.prototype.filter.call(
      prose.querySelectorAll('h2, h3'),
      function (hd) { return !hd.classList.contains('card__title'); }
    );
    if (!heads.length) { aside.style.display = 'none'; return; }

    var ol = doc.createElement('ol');
    heads.forEach(function (hd, i) {
      if (!hd.id) {
        hd.id = 'sec-' + (i + 1) + '-' + (hd.textContent || '').trim()
          .replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
      }
      var li = doc.createElement('li');
      var a = doc.createElement('a');
      a.href = '#' + hd.id;
      // 去掉 h2 里的编号徽标文字影响
      var numEl = hd.querySelector('.hnum');
      var text = hd.textContent.trim();
      if (numEl) text = text.replace(numEl.textContent.trim(), '').trim();
      a.textContent = text;
      if (hd.tagName === 'H3') a.className = 'toc__sub';
      li.appendChild(a);
      ol.appendChild(li);
    });
    aside.appendChild(ol);

    var links = Array.prototype.slice.call(aside.querySelectorAll('a'));
    var map = new Map();
    links.forEach(function (a) {
      var id = a.getAttribute('href').slice(1);
      var t = doc.getElementById(id);
      if (t) map.set(t, a);
    });

    var setActive = function (target) {
      links.forEach(function (a) { a.classList.remove('active'); });
      var a = map.get(target);
      if (a) a.classList.add('active');
    };

    if ('IntersectionObserver' in root) {
      var visible = new Map();
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) visible.set(en.target, en.boundingClientRect.top);
          else visible.delete(en.target);
        });
        if (!visible.size) return;
        var best = null, bestTop = Infinity;
        visible.forEach(function (top, el) {
          if (top < bestTop) { bestTop = top; best = el; }
        });
        if (best) setActive(best);
      }, { rootMargin: '-72px 0px -62% 0px', threshold: [0, 1] });
      map.forEach(function (_, el) { io.observe(el); });
    }
  }

  /* ---------- 测验引擎 ---------- */

  /**
   结构约定:
   <div class="quiz" data-quiz>
     <div class="q" data-answer="B">
       <p class="q__stem">…</p>
       <div class="opts">
         <label class="opt"><input type="radio" name="q1" value="A"><span class="opt__k">A</span><span>…</span></label>
       </div>
       <div class="q__exp">…</div>
     </div>
   </div>
   <div class="quizbar"><span class="quizbar__score"></span><button class="btn--ghost" data-quiz-reset>重做</button></div>
   */
  function initQuiz() {
    // 同时兼容 class="quiz" 与 data-quiz 两种写法
    var quizzes = doc.querySelectorAll('.quiz, [data-quiz]');
    if (!quizzes.length) return;

    quizzes.forEach(function (quiz, qi) {
      var qs = Array.prototype.slice.call(quiz.querySelectorAll('.q'));
      var bar = doc.querySelector('[data-quizbar="' + (quiz.id || qi) + '"]') ||
        quiz.parentElement.querySelector('.quizbar');
      var scoreEl = bar ? bar.querySelector('.quizbar__score') : null;

      var state = { answered: 0, correct: 0 };

      function update() {
        if (!scoreEl) return;
        var total = qs.length;
        var pctVal = state.answered ? Math.round(state.correct / qs.length * 100) : 0;
        scoreEl.innerHTML = '已答 <b>' + state.answered + '/' + total + '</b> · 正确 <b style="color:var(--profit)">' +
          state.correct + '</b> · 正确率 <b>' + pctVal + '%</b>';
      }

      qs.forEach(function (q, i) {
        var answer = (q.getAttribute('data-answer') || '').trim().toUpperCase();
        var inputs = q.querySelectorAll('input[type="radio"]');

        inputs.forEach(function (inp) {
          inp.name = inp.name || ('quiz' + qi + '-q' + i);
          inp.addEventListener('change', function () {
            if (q.classList.contains('answered')) return;
            var chosen = (inp.value || '').trim().toUpperCase();

            // 标记所有选项
            q.querySelectorAll('.opt').forEach(function (lb) {
              var v = (lb.querySelector('input').value || '').trim().toUpperCase();
              if (v === answer) lb.classList.add('is-right');
              else if (v === chosen) lb.classList.add('is-wrong');
            });

            // 锁定
            inputs.forEach(function (x) { x.disabled = true; });

            q.classList.add('answered');
            q.setAttribute('data-correct', chosen === answer ? 'yes' : 'no');
            state.answered++;
            if (chosen === answer) state.correct++;
            update();
          });
        });
      });

      if (bar) {
        var reset = bar.querySelector('[data-quiz-reset]');
        if (reset) {
          reset.addEventListener('click', function () {
            qs.forEach(function (q) {
              q.classList.remove('answered');
              q.removeAttribute('data-correct');
              q.querySelectorAll('.opt').forEach(function (lb) {
                lb.classList.remove('is-right', 'is-wrong');
              });
              q.querySelectorAll('input').forEach(function (x) {
                x.disabled = false;
                x.checked = false;
              });
            });
            state.answered = 0; state.correct = 0;
            update();
            quiz.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        }
      }
      update();
    });
  }

  /* ---------- 交互控件小工具 ---------- */

  /** 数字格式化到指定小数位的滑块读数绑定 */
  function bindSlider(id, onInput, fmtFn) {
    var inp = doc.getElementById(id);
    if (!inp) return null;
    var out = doc.querySelector('[data-for="' + id + '"]');
    var fire = function () {
      if (out && fmtFn) out.textContent = fmtFn(parseFloat(inp.value));
      if (onInput) onInput(parseFloat(inp.value));
    };
    inp.addEventListener('input', fire);
    fire();
    return inp;
  }

  /** 分段按钮组:点击后设置 aria-pressed 并回调 */
  function bindSeg(container, onPick, initial) {
    var box = typeof container === 'string' ? doc.getElementById(container) : container;
    if (!box) return null;
    var btns = Array.prototype.slice.call(box.querySelectorAll('button'));
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        btns.forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        if (onPick) onPick(b.getAttribute('data-val'), b);
      });
    });
    if (initial !== undefined) {
      var target = btns.filter(function (b) { return b.getAttribute('data-val') === String(initial); })[0];
      if (target) {
        btns.forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        target.setAttribute('aria-pressed', 'true');
      }
    }
    return btns;
  }

  function $(sel, ctx) { return (ctx || doc).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); }

  /* ---------- 深浅色主题 ---------- */

  var THEME_KEY = 'optionswiki-theme';

  function initTheme() {
    var el = doc.documentElement;

    // head 里的内联脚本已抢先应用过 localStorage;此处兜底并同步按钮状态
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (e) { /* 隐私模式等 */ }
    if (stored === 'dark' || stored === 'light') el.setAttribute('data-theme', stored);
    if (!el.getAttribute('data-theme')) el.setAttribute('data-theme', 'light');

    var btns = doc.querySelectorAll('[data-theme-toggle]');
    if (!btns.length) return;

    function paint() {
      var dark = el.getAttribute('data-theme') === 'dark';
      var label = dark ? '切换到浅色主题' : '切换到深色主题';
      btns.forEach(function (b) {
        b.textContent = dark ? '☀' : '☾';
        b.setAttribute('aria-label', label);
        b.setAttribute('title', label);
        b.setAttribute('aria-pressed', dark ? 'true' : 'false');
      });
    }

    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        var dark = el.getAttribute('data-theme') === 'dark';
        var next = dark ? 'light' : 'dark';
        el.setAttribute('data-theme', next);
        try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 忽略 */ }
        paint();
        // 图表颜色从 CSS 令牌读取,因此切换后需要重绘
        if (root.Charts && root.Charts.redrawAll) root.Charts.redrawAll();
      });
    });

    paint();
  }

  /* ---------- 启动 ---------- */

  function init() {
    initTheme();
    initNav();
    initToc();
    initQuiz();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();

  root.Site = {
    n: n, money: money, signed: signed, pct: pct, signedPct: signedPct,
    plClass: plClass, orInf: orInf,
    bindSlider: bindSlider, bindSeg: bindSeg,
    $: $, $$: $$
  };
})(typeof window !== 'undefined' ? window : globalThis, document);
