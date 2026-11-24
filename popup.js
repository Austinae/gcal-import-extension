const modeEl = document.getElementById('importMode');
const calendarEl = document.getElementById('defaultCalendarName');
const statusEl = document.getElementById('status');

async function load() {
  const { importMode, defaultCalendarName } = await chrome.storage.sync.get({
    importMode: 'quick',
    defaultCalendarName: ''
  });
  modeEl.value = importMode;
  calendarEl.value = defaultCalendarName;
}

function save() {
  chrome.storage.sync
    .set({
      importMode: modeEl.value,
      defaultCalendarName: calendarEl.value.trim()
    })
    .then(() => {
      statusEl.textContent = 'Saved.';
      setTimeout(() => {
        statusEl.textContent = '';
      }, 1500);
    });
}

modeEl.addEventListener('change', save);
calendarEl.addEventListener('change', save);

load();