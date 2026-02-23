(function () {
  'use strict';

  const CONFIG = {
    assignmentId: window.SF_CONFIG?.assignmentId || prompt('Assignment ID:'),
    startDate: '2026-02-01',
    baseUrl: '/odatav4/timemanagement/attendance/AttendanceRecordingUi.svc/v2',
    batchBoundary: 'batch_sf_overtime_calc',
    weeklyHours: 40,
    panelWidth: 380,
  };

  // ─── Hilfsfunktionen ───────────────────────────────────────────────

  function getMonday(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    return d;
  }

  function formatDate(d) {
    return d.toISOString().split('T')[0];
  }

  function getAllMondays(startDateStr) {
    const mondays = [];
    let current = getMonday(new Date(startDateStr));
    const now = new Date();
    const currentMonday = getMonday(now);
    while (current <= currentMonday) {
      mondays.push(formatDate(current));
      current.setDate(current.getDate() + 7);
    }
    return mondays;
  }

  function parseHoursMinutes(str) {
    if (!str) return 0;
    const parts = str.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  // ─── CSRF Token ────────────────────────────────────────────────────

  async function fetchCsrfToken() {
    const res = await fetch(CONFIG.baseUrl + '/', {
      method: 'HEAD',
      headers: { 'x-csrf-token': 'fetch' },
      credentials: 'include',
    });
    return res.headers.get('x-csrf-token');
  }

  // ─── Batch-Request ─────────────────────────────────────────────────

  function buildBatchBody(monday) {
    const expand = [
      'valuationResults($select=timeTypeGroupName,value,previousValue,timeCategory)',
      'days($expand=attendances($expand=attendanceType,costCenter_Nav($filter=includeInactiveRecords%20eq%20true)),onCalls($expand=costCenter_Nav($filter=includeInactiveRecords%20eq%20true),onCallType),allowances($expand=allowanceType,costCenter_Nav($filter=includeInactiveRecords%20eq%20true)),absences,plannedAttendanceSegments)',
      'timeCollectors($select=timeTypeGroupName,startDate,endDate,value,isEventCollector)',
      'timeContainers($select=timeTypeGroupName,startDate,endDate,value,timeCategory)',
      'onCallSummaries',
      'allowanceSummaries',
      'absenceSummaries',
    ].join(',');

    const select = [
      'shiftDate','startDate','endDate','approvalStatusText','approvalStatusKey',
      'assignmentId','comment','plannedWorkingTimeHoursAndMinutes',
      'recordedWorkingTimeHoursAndMinutes','isAdmissible','update_mc',
      'isAmendmentScenario','rowId','userDisplayName','plannedWorkingTimeInDays',
      'recordedWorkingTimeInDays','valuationResults','days','timeContainers',
      'timeCollectors','messages','onCallSummaries','allowanceSummaries',
      'absenceSummaries','usedRecordingMethod','permission','toilTimeAccount',
      'workingTimeAccount','hasCopyableTypes',
    ].join(',');

    const entityPath = `TimeSheetSummary(assignmentId='${CONFIG.assignmentId}',shiftDate=${monday})`;
    const queryString = `$expand=${expand}&$select=${select}`;

    return [
      `--${CONFIG.batchBoundary}`,
      'Content-Type:application/http',
      'Content-Transfer-Encoding:binary',
      '',
      `GET ${entityPath}?${queryString} HTTP/1.1`,
      'Accept:application/json;odata.metadata=minimal;IEEE754Compatible=true',
      'Accept-Language:de-DE',
      'Content-Type:application/json;charset=UTF-8;IEEE754Compatible=true',
      '',
      '',
      `--${CONFIG.batchBoundary}--`,
    ].join('\r\n');
  }

  async function fetchWeek(monday, csrfToken) {
    const body = buildBatchBody(monday);
    const res = await fetch(CONFIG.baseUrl + '/$batch', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'multipart/mixed',
        'Content-Type': `multipart/mixed; boundary=${CONFIG.batchBoundary}`,
        'x-csrf-token': csrfToken,
        'OData-Version': '4.0',
        'OData-MaxVersion': '4.0',
      },
      body: body,
    });

    const text = await res.text();
    if (text.includes('"error"') || text.includes('HTTP/1.1 4') || text.includes('HTTP/1.1 5')) {
      console.warn('Woche ' + monday + ' übersprungen (Fehler in Response)');
      return null;
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.error) {
        console.warn('Woche ' + monday + ' übersprungen:', parsed.error.message || 'Unbekannter Fehler');
        return null;
      }
      return parsed;
    } catch (e) {
      console.warn('Parse-Fehler für Woche ' + monday, e);
      return null;
    }
  }

  // ─── Wochendaten auswerten ─────────────────────────────────────────

  function analyzeWeek(data, monday) {
    if (!data || !data.days) return null;

    const plannedMinutes = parseHoursMinutes(data.plannedWorkingTimeHoursAndMinutes);
    let recordedInclAbsencesMinutes = 0;
    let absenceMinutes = 0;
    let workedMinutes = 0;
    const dayDetails = [];

    for (const day of data.days) {
      const s = day.summary;
      if (!s) continue;

      const dayPlanned = s.plannedWorkingTimeInMinutes || 0;
      const dayRecorded = s.recordedWorkingTimeInMinutes || 0;
      const dayRecordedInclAbs = s.recordedWorkingTimeInclAbsencesInMinutes || 0;
      const dayAbsenceMinutes = dayRecordedInclAbs - dayRecorded;

      recordedInclAbsencesMinutes += dayRecordedInclAbs;
      absenceMinutes += dayAbsenceMinutes;
      workedMinutes += dayRecorded;

      dayDetails.push({
        date: day.shiftDate,
        isWorkingDay: day.isWorkingDay,
        planned: dayPlanned,
        recorded: dayRecorded,
        recordedInclAbsences: dayRecordedInclAbs,
        absences: dayAbsenceMinutes,
        delta: dayRecordedInclAbs - dayPlanned,
        holiday: day.holiday || null,
        absenceNames: (day.absences || []).map(a => a.absenceTypeName),
      });
    }

    const delta = recordedInclAbsencesMinutes - plannedMinutes;

    return {
      monday,
      startDate: data.startDate,
      endDate: data.endDate,
      plannedMinutes,
      workedMinutes,
      absenceMinutes,
      recordedInclAbsencesMinutes,
      delta,
      status: data.approvalStatusText,
      days: dayDetails,
    };
  }

  // ─── Formatierung ──────────────────────────────────────────────────

  function formatMinutes(min) {
    const sign = min < 0 ? '-' : '+';
    const abs = Math.abs(min);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    if (min === 0) return '±0:00';
    return `${sign}${h}:${m.toString().padStart(2, '0')}`;
  }

  function formatMinutesUnsigned(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}:${m.toString().padStart(2, '0')}`;
  }

  // ─── Offcanvas Panel ───────────────────────────────────────────────

  let panelOpen = false;

  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'sf-ot-styles';
    style.textContent = `
      /* ── Transition auf den SAP-Body ── */
      body.sf-ot-panel-open {
        margin-right: ${CONFIG.panelWidth}px !important;
        transition: margin-right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      body {
        transition: margin-right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }

      /* ── Panel ── */
      #sf-ot-panel {
        position: fixed;
        top: 0;
        right: 0;
        width: ${CONFIG.panelWidth}px;
        height: 100vh;
        z-index: 99999;
        display: flex;
        flex-direction: column;
        background: #f7f8fa;
        border-left: 1px solid #d1d5db;
        box-shadow: -2px 0 12px rgba(0, 0, 0, 0.06);
        transform: translateX(100%);
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        font-family: '72', '72full', Arial, Helvetica, sans-serif;
        font-size: 13px;
        color: #32363a;
      }
      #sf-ot-panel.open {
        transform: translateX(0);
      }

      /* ── Header ── */
      #sf-ot-header {
        padding: 14px 16px;
        background: #fff;
        border-bottom: 1px solid #d1d5db;
        display: flex;
        align-items: center;
        gap: 10px;
        flex-shrink: 0;
      }
      #sf-ot-header .sf-ot-icon {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: #0a6ed1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font-size: 16px;
        flex-shrink: 0;
      }
      #sf-ot-header .sf-ot-titles {
        flex: 1;
        min-width: 0;
      }
      #sf-ot-header .sf-ot-titles h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 700;
        color: #32363a;
        line-height: 1.3;
      }
      #sf-ot-header .sf-ot-titles .sf-ot-sub {
        font-size: 11px;
        color: #6a6d70;
        margin-top: 1px;
      }
      .sf-ot-hdr-btn {
        width: 32px;
        height: 32px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: none;
        color: #6a6d70;
        font-size: 15px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: all 0.15s;
      }
      .sf-ot-hdr-btn:hover {
        background: #eaecee;
        border-color: #d1d5db;
        color: #32363a;
      }

      /* ── Balance Card ── */
      #sf-ot-balance-card {
        margin: 12px 16px 0;
        padding: 16px;
        background: #fff;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        flex-shrink: 0;
      }
      #sf-ot-balance-card .sf-ot-big {
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.5px;
        line-height: 1.1;
      }
      #sf-ot-balance-card .sf-ot-big.pos { color: #107e3e; }
      #sf-ot-balance-card .sf-ot-big.neg { color: #bb0000; }
      #sf-ot-balance-card .sf-ot-big.zero { color: #6a6d70; }
      #sf-ot-balance-card .sf-ot-label {
        font-size: 11px;
        color: #6a6d70;
        margin-top: 2px;
      }
      .sf-ot-kpis {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 8px;
        margin-top: 14px;
        padding-top: 12px;
        border-top: 1px solid #eaecee;
      }
      .sf-ot-kpi {
        text-align: center;
      }
      .sf-ot-kpi .val {
        font-size: 14px;
        font-weight: 600;
        color: #32363a;
      }
      .sf-ot-kpi .lbl {
        font-size: 10px;
        color: #6a6d70;
        margin-top: 2px;
        text-transform: uppercase;
        letter-spacing: 0.3px;
      }

      /* ── Progress ── */
      .sf-ot-progress-bar {
        margin: 12px 16px 0;
        height: 3px;
        background: #eaecee;
        border-radius: 2px;
        overflow: hidden;
        flex-shrink: 0;
      }
      .sf-ot-progress-bar .fill {
        height: 100%;
        border-radius: 2px;
        transition: width 0.5s ease;
      }

      /* ── Wochen-Liste ── */
      #sf-ot-weeks {
        flex: 1;
        overflow-y: auto;
        padding: 8px 16px 16px;
        scrollbar-width: thin;
        scrollbar-color: #c4c6c8 transparent;
      }
      #sf-ot-weeks::-webkit-scrollbar { width: 4px; }
      #sf-ot-weeks::-webkit-scrollbar-thumb { background: #c4c6c8; border-radius: 2px; }

      .sf-ot-week-header {
        display: grid;
        grid-template-columns: 1fr 52px 52px 56px 40px;
        gap: 4px;
        padding: 8px 0 6px;
        font-size: 10px;
        font-weight: 600;
        color: #6a6d70;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        border-bottom: 1px solid #d1d5db;
      }
      .sf-ot-week-row {
        display: grid;
        grid-template-columns: 1fr 52px 52px 56px 40px;
        gap: 4px;
        padding: 7px 0;
        border-bottom: 1px solid #eaecee;
        align-items: center;
        font-size: 12px;
        transition: background 0.1s;
      }
      .sf-ot-week-row:hover {
        background: #f0f1f3;
        margin: 0 -8px;
        padding-left: 8px;
        padding-right: 8px;
        border-radius: 4px;
      }
      .sf-ot-week-row .wk-label {
        font-weight: 500;
        color: #32363a;
      }
      .sf-ot-week-row .wk-label .wk-abs {
        display: block;
        font-size: 10px;
        font-weight: 400;
        color: #6a6d70;
        margin-top: 1px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .sf-ot-week-row .wk-num {
        text-align: right;
        color: #6a6d70;
        font-variant-numeric: tabular-nums;
      }
      .sf-ot-week-row .wk-delta {
        text-align: right;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .sf-ot-week-row .wk-delta.pos { color: #107e3e; }
      .sf-ot-week-row .wk-delta.neg { color: #bb0000; }
      .sf-ot-week-row .wk-delta.zero { color: #6a6d70; }
      .sf-ot-week-row .wk-bar {
        display: flex;
        align-items: center;
        justify-content: flex-start;
      }
      .sf-ot-week-row .wk-bar-inner {
        height: 5px;
        border-radius: 3px;
        min-width: 2px;
      }
      .sf-ot-week-row .wk-bar-inner.pos { background: #107e3e; }
      .sf-ot-week-row .wk-bar-inner.neg { background: #bb0000; }

      /* ── Loading ── */
      #sf-ot-loading {
        padding: 48px 20px;
        text-align: center;
        color: #6a6d70;
      }
      #sf-ot-loading .sf-ot-spinner {
        display: inline-block;
        width: 28px;
        height: 28px;
        border: 3px solid #eaecee;
        border-top-color: #0a6ed1;
        border-radius: 50%;
        animation: sf-ot-spin 0.7s linear infinite;
        margin-bottom: 14px;
      }
      @keyframes sf-ot-spin { to { transform: rotate(360deg); } }
      #sf-ot-loading .sf-ot-prog {
        font-size: 11px;
        margin-top: 6px;
        color: #89919a;
      }

      /* ── Toggle-Tab am Rand ── */
      #sf-ot-tab {
        position: fixed;
        top: 50%;
        right: 0;
        transform: translateY(-50%);
        z-index: 99998;
        writing-mode: vertical-rl;
        text-orientation: mixed;
        background: #0a6ed1;
        color: #fff;
        border: none;
        border-radius: 6px 0 0 6px;
        padding: 12px 7px;
        font-family: '72', '72full', Arial, Helvetica, sans-serif;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.5px;
        cursor: pointer;
        box-shadow: -2px 0 8px rgba(0, 0, 0, 0.1);
        transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1), background 0.15s;
      }
      #sf-ot-tab:hover {
        background: #0854a0;
      }
      #sf-ot-tab.shifted {
        right: ${CONFIG.panelWidth}px;
      }

      /* ── Error ── */
      .sf-ot-error {
        padding: 32px 20px;
        text-align: center;
        color: #bb0000;
      }
      .sf-ot-error .icon { font-size: 28px; margin-bottom: 8px; }
      .sf-ot-error .msg { font-size: 13px; }
      .sf-ot-error .hint { font-size: 11px; color: #6a6d70; margin-top: 8px; }
    `;
    document.head.appendChild(style);
  }

  function createPanel() {
    const existing = document.getElementById('sf-ot-panel');
    if (existing) existing.remove();
    const existingTab = document.getElementById('sf-ot-tab');
    if (existingTab) existingTab.remove();

    // Panel
    const panel = document.createElement('div');
    panel.id = 'sf-ot-panel';
    panel.innerHTML = `
      <div id="sf-ot-header">
        <div class="sf-ot-icon">⏱</div>
        <div class="sf-ot-titles">
          <h3>Überstunden</h3>
          <div class="sf-ot-sub">ab ${new Date(CONFIG.startDate).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
        </div>
        <button class="sf-ot-hdr-btn" id="sf-ot-refresh" title="Aktualisieren (Shift = Cache leeren)">↻</button>
        <button class="sf-ot-hdr-btn" id="sf-ot-close" title="Schließen">✕</button>
      </div>
      <div id="sf-ot-balance-card"></div>
      <div class="sf-ot-progress-bar"><div class="fill"></div></div>
      <div id="sf-ot-weeks">
        <div id="sf-ot-loading">
          <div class="sf-ot-spinner"></div>
          <div>Lade Zeitdaten…</div>
          <div class="sf-ot-prog" id="sf-ot-progress-text"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // Tab-Button
    const tab = document.createElement('button');
    tab.id = 'sf-ot-tab';
    tab.textContent = '⏱ Überstunden';
    document.body.appendChild(tab);

    // Events
    tab.addEventListener('click', () => togglePanel(true));
    panel.querySelector('#sf-ot-close').addEventListener('click', () => togglePanel(false));
    panel.querySelector('#sf-ot-refresh').addEventListener('click', (e) => runCalculation(e.shiftKey));

    return panel;
  }

  function togglePanel(open) {
    const panel = document.getElementById('sf-ot-panel');
    const tab = document.getElementById('sf-ot-tab');
    if (!panel || !tab) return;

    panelOpen = open;

    if (open) {
      panel.classList.add('open');
      tab.classList.add('shifted');
      document.body.classList.add('sf-ot-panel-open');
    } else {
      panel.classList.remove('open');
      tab.classList.remove('shifted');
      document.body.classList.remove('sf-ot-panel-open');
    }
  }

  // ─── Ergebnisse rendern ────────────────────────────────────────────

  function renderResults(weeks) {
    const balanceEl = document.getElementById('sf-ot-balance-card');
    const weeksEl = document.getElementById('sf-ot-weeks');
    const progressBar = document.querySelector('.sf-ot-progress-bar .fill');

    let totalDelta = 0, totalPlanned = 0, totalWorked = 0, totalAbsence = 0;
    const validWeeks = weeks.filter(w => w !== null);

    for (const w of validWeeks) {
      totalDelta += w.delta;
      totalPlanned += w.plannedMinutes;
      totalWorked += w.workedMinutes;
      totalAbsence += w.absenceMinutes;
    }

    const cls = totalDelta > 0 ? 'pos' : totalDelta < 0 ? 'neg' : 'zero';

    balanceEl.innerHTML = `
      <div class="sf-ot-big ${cls}">${formatMinutes(totalDelta)}</div>
      <div class="sf-ot-label">Saldo aus ${validWeeks.length} Wochen</div>
      <div class="sf-ot-kpis">
        <div class="sf-ot-kpi"><div class="val">${formatMinutesUnsigned(totalPlanned)}</div><div class="lbl">Soll</div></div>
        <div class="sf-ot-kpi"><div class="val">${formatMinutesUnsigned(totalWorked)}</div><div class="lbl">Ist</div></div>
        <div class="sf-ot-kpi"><div class="val">${formatMinutesUnsigned(totalAbsence)}</div><div class="lbl">Abwesend</div></div>
      </div>
    `;

    // Progress
    const ratio = totalPlanned > 0 ? (totalWorked + totalAbsence) / totalPlanned : 1;
    progressBar.style.width = Math.min(ratio * 100, 150) + '%';
    progressBar.style.background = totalDelta >= 0 ? '#107e3e' : '#bb0000';

    // Wochen
    const maxAbsDelta = Math.max(...validWeeks.map(w => Math.abs(w.delta)), 60);
    const sorted = [...validWeeks].reverse();

    let html = `
      <div class="sf-ot-week-header">
        <div>Woche</div>
        <div style="text-align:right">Soll</div>
        <div style="text-align:right">Ist</div>
        <div style="text-align:right">Delta</div>
        <div></div>
      </div>
    `;

    for (const w of sorted) {
      const deltaStr = formatMinutes(w.delta);
      const dCls = w.delta > 0 ? 'pos' : w.delta < 0 ? 'neg' : 'zero';
      const barW = Math.round((Math.abs(w.delta) / maxAbsDelta) * 100);
      const weekLabel = w.monday.substring(5);

      let absLabel = '';
      const absenceDays = w.days.filter(d => d.absenceNames.length > 0);
      if (absenceDays.length > 0) {
        const names = [...new Set(absenceDays.flatMap(d => d.absenceNames))];
        absLabel = `<span class="wk-abs">${names.join(', ')}</span>`;
      }

      html += `
        <div class="sf-ot-week-row" title="KW ab ${w.monday}">
          <div class="wk-label">${weekLabel}${absLabel}</div>
          <div class="wk-num">${formatMinutesUnsigned(w.plannedMinutes)}</div>
          <div class="wk-num">${formatMinutesUnsigned(w.recordedInclAbsencesMinutes)}</div>
          <div class="wk-delta ${dCls}">${deltaStr}</div>
          <div class="wk-bar"><div class="wk-bar-inner ${dCls}" style="width:${barW}%"></div></div>
        </div>
      `;
    }

    weeksEl.innerHTML = html;
  }

  // ─── Cache ─────────────────────────────────────────────────────────

  const CACHE_KEY = 'sf-overtime-week-cache';

  function loadWeekCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
    catch { return {}; }
  }

  function saveWeekCache(cache) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); }
    catch (e) { console.warn('Cache-Fehler:', e); }
  }

  // ─── Hauptberechnung ───────────────────────────────────────────────

  async function runCalculation(forceReload) {
    createPanel();
    togglePanel(true);

    const progressText = document.getElementById('sf-ot-progress-text');

    try {
      const csrfToken = await fetchCsrfToken();
      const mondays = getAllMondays(CONFIG.startDate);
      const cache = forceReload ? {} : loadWeekCache();
      const results = [];

      const currentMonday = formatDate(getMonday(new Date()));
      const toFetch = mondays.filter(m => m === currentMonday || !cache[m]);
      const fromCache = mondays.length - toFetch.length;

      if (fromCache > 0) {
        progressText.textContent = `${fromCache} aus Cache, ${toFetch.length} laden…`;
      } else {
        progressText.textContent = `0 / ${mondays.length} Wochen`;
      }

      let fetchCount = 0;

      for (const monday of mondays) {
        const isCurrentWeek = monday === currentMonday;

        if (!isCurrentWeek && cache[monday] && !forceReload) {
          results.push(cache[monday]);
          continue;
        }

        fetchCount++;
        progressText.textContent = `${fetchCount} / ${toFetch.length}${fromCache > 0 ? ` (+${fromCache} Cache)` : ''} – ${monday}`;

        const data = await fetchWeek(monday, csrfToken);
        const analysis = analyzeWeek(data, monday);
        results.push(analysis);

        if (!isCurrentWeek && analysis !== null) {
          cache[monday] = analysis;
        }

        if (fetchCount < toFetch.length) {
          await new Promise(r => setTimeout(r, 150));
        }
      }

      saveWeekCache(cache);
      renderResults(results);

    } catch (err) {
      console.error('SF Überstundenrechner Fehler:', err);
      document.getElementById('sf-ot-weeks').innerHTML = `
        <div class="sf-ot-error">
          <div class="icon">⚠️</div>
          <div class="msg">${err.message}</div>
          <div class="hint">Bist du auf der SuccessFactors-Seite eingeloggt?</div>
        </div>
      `;
    }
  }

  // ─── Init ──────────────────────────────────────────────────────────

  function init() {
    injectStyles();
    createPanel();
    // Panel initial geschlossen starten – Tab ist sichtbar
    togglePanel(false);
    runCalculation(false);
  }

  if (document.readyState === 'complete') {
    setTimeout(init, 2000);
  } else {
    window.addEventListener('load', () => setTimeout(init, 2000));
  }
})();
