const JOB_PREFIX = 'gcal_import_job_';
const TAB_PREFIX = 'gcal_import_tab_';
const JOB_TTL_MS = 10 * 60 * 1000;
const MAX_FILE_BYTES = 6 * 1024 * 1024;

function exportUrlFromTabUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const match = u.pathname.match(/^(\/calendar\/u\/\d+)/);
    const prefix = match ? match[1] : '/calendar/u/0';
    return `https://calendar.google.com${prefix}/r/settings/export`;
  } catch {
    return 'https://calendar.google.com/calendar/u/0/r/settings/export';
  }
}

async function saveJob(job) {
  const payload = { [`${JOB_PREFIX}${job.jobId}`]: job };
  if (job.targetTabId != null) {
    payload[`${TAB_PREFIX}${job.targetTabId}`] = job.jobId;
  }
  await chrome.storage.session.set(payload);
}

async function getJob(jobId) {
  const key = `${JOB_PREFIX}${jobId}`;
  const data = await chrome.storage.session.get(key);
  const job = data[key];
  if (!job) return null;
  if (Date.now() - job.createdAt > JOB_TTL_MS) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return job;
}

async function consumeJobForTab(tabId, jobIdHint) {
  let jobId = jobIdHint;
  if (!jobId) {
    const data = await chrome.storage.session.get(`${TAB_PREFIX}${tabId}`);
    jobId = data[`${TAB_PREFIX}${tabId}`];
  }
  if (!jobId) return null;
  const job = await getJob(jobId);
  if (!job) return null;
  await chrome.storage.session.remove([
    `${JOB_PREFIX}${jobId}`,
    `${TAB_PREFIX}${tabId}`
  ]);
  return job;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'START_IMPORT': {
        const sourceTabId = sender.tab?.id;
        if (sourceTabId == null) {
          sendResponse({ ok: false, error: 'Missing source tab' });
          return;
        }

        if (!message.fileBase64 || !message.fileName) {
          sendResponse({ ok: false, error: 'Missing file payload' });
          return;
        }

        const settings = await chrome.storage.sync.get({
          defaultCalendarName: '',
          importMode: 'quick'
        });

        const exportUrl =
          message.exportUrl || exportUrlFromTabUrl(sender.tab?.url || '');

        const jobId = crypto.randomUUID();
        const job = {
          jobId,
          mode: settings.importMode === 'pick' ? 'pick' : 'quick',
          sourceTabId,
          targetTabId: null,
          returnUrl: sender.tab?.url || null,
          fileName: message.fileName,
          fileType: message.fileType || 'text/calendar',
          fileBase64: message.fileBase64,
          defaultCalendarName: (settings.defaultCalendarName || '').trim(),
          exportUrl,
          createdAt: Date.now()
        };

        if (job.mode === 'pick') {
          await saveJob(job);
          sendResponse({
            ok: true,
            jobId,
            navigateTo: `${exportUrl}#gcal-import-job=${encodeURIComponent(jobId)}`
          });
          return;
        }

        await saveJob(job);
        const bgTab = await chrome.tabs.create({
          url: `${exportUrl}#gcal-import-job=${encodeURIComponent(jobId)}`,
          active: false
        });
        job.targetTabId = bgTab.id;
        await saveJob(job);
        sendResponse({ ok: true, jobId, bgTabId: bgTab.id });
        return;
      }

      case 'LOOKUP_JOB_FOR_TAB': {
        const tabId = sender.tab?.id;
        let jobId = message.jobIdHint || null;
        if (!jobId && tabId != null) {
          const data = await chrome.storage.session.get(`${TAB_PREFIX}${tabId}`);
          jobId = data[`${TAB_PREFIX}${tabId}`];
        }
        const job = jobId ? await getJob(jobId) : null;
        sendResponse({ ok: true, job, jobId });
        return;
      }

      case 'CONSUME_JOB': {
        const job = await consumeJobForTab(
          sender.tab?.id,
          message.jobIdHint || null
        );
        sendResponse({ ok: true, job });
        return;
      }

      case 'IMPORT_FINISHED': {
        const { ok, statusText, fileName, calendarName, keepTabOpen } = message;
        const bgTabId = sender.tab?.id;
        const sourceTabId = message.sourceTabId;

        if (sourceTabId != null) {
          try {
            await chrome.tabs.sendMessage(sourceTabId, {
              type: 'IMPORT_DONE',
              ok,
              statusText,
              fileName,
              calendarName
            });
          } catch {
            // Source tab may have navigated away.
          }
        }

        if (bgTabId != null && !keepTabOpen) {
          try {
            await chrome.tabs.remove(bgTabId);
          } catch {
            // Tab may already be closed.
          }
        }

        sendResponse({ ok: true });
        return;
      }

      case 'ATTACH_FILE_MAIN_WORLD': {
        const tabId = sender.tab?.id;
        if (tabId == null) {
          sendResponse({ ok: false, error: 'Missing tab id' });
          return;
        }

        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: 'MAIN',
          args: [message.fileBase64, message.fileName, message.fileType || ''],
          func: (fileBase64, fileName, fileType) => {
            function collectFileInputs(root, acc = []) {
              if (!root?.querySelectorAll) return acc;
              for (const el of root.querySelectorAll('input[type="file"]')) {
                acc.push(el);
              }
              for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) collectFileInputs(el.shadowRoot, acc);
              }
              return acc;
            }

            function scoreInput(input) {
              let score = 0;
              const accept = (input.getAttribute('accept') || '').toLowerCase();
              const name = (input.getAttribute('name') || '').toLowerCase();
              if (/(ics|ical|csv|calendar)/i.test(accept)) score += 30;
              if (/(file|import|ics)/i.test(name)) score += 10;
              if (input.closest('[role="main"], main')) score += 20;

              let p = input.parentElement;
              for (let depth = 0; depth < 6 && p; depth++, p = p.parentElement) {
                const txt = (p.innerText || p.textContent || '').trim();
                if (/(select file|from your computer)/i.test(txt)) {
                  score += 50;
                  break;
                }
                if (/import/i.test(txt)) score += 15;
              }
              return score;
            }

            const inputs = collectFileInputs(document);
            if (inputs.length === 0) {
              return { found: false, count: 0 };
            }

            const target = inputs
              .map((el) => ({ el, score: scoreInput(el) }))
              .sort((a, b) => b.score - a.score)[0].el;

            const binary = atob(fileBase64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }

            const inferredType =
              fileType || (/\.csv$/i.test(fileName) ? 'text/csv' : 'text/calendar');
            const file = new File([bytes], fileName, {
              type: inferredType,
              lastModified: Date.now()
            });

            const dt = new DataTransfer();
            dt.items.add(file);

            const setter = Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              'files'
            )?.set;
            if (setter) setter.call(target, dt.files);
            else target.files = dt.files;

            target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

            return {
              found: true,
              count: inputs.length,
              filesLength: target.files?.length || 0
            };
          }
        });

        const result = results?.[0]?.result;
        sendResponse({ ok: Boolean(result?.found), result });
        return;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })().catch((err) => {
    console.error('[GCal Quick Import]', err);
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});