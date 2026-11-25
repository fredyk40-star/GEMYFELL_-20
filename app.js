
    const RECORDS_KEY = 'gemyfell_disc_records';
    const DELETED_RECORDS_KEY = 'gemyfell_deleted_records';
    const AUTH_SESSION_KEY = 'gemyfell_admin_session';
    const PIN_SETUP_TOKEN_KEY = 'gemyfell_pin_setup_token';
    const PHONE_KEY = 'gemyfell_team_phones';
    const PENDING_PHONE_WRITES_KEY = 'gemyfell_pending_phone_writes';
    const ROLLCALLS_KEY = 'gemyfell_shared_rollcalls';
    const PENDING_ROLLCALL_KEY = 'gemyfell_pending_rollcalls';
    const EXTRA_MEMBERS_KEY = 'gemyfell_extra_members';
    const MESSAGE_HISTORY_KEY = 'gemyfell_message_history';
    const STATUSES = ['Present', 'Late', 'Excused', 'Absent'];
    const ALLOWED_RECORD_TYPES = new Set(['Incident Report', 'Meeting Minutes', 'Attendance']);
    const TEAM_GROUPS = [
      { name: 'Board', people: [{ name: 'Brother Emma', role: 'Chairman' }, { name: 'Brother Obrepong Danso', role: 'Vice Chairman' }] },
      { name: 'Secretariat', people: [{ name: 'Brother Fred', role: 'Secretary' }, { name: 'Miss Boahemaa', role: 'Vice Secretary' }] },
      { name: 'Financial Team', people: [{ name: 'Miss Ellen Boatemaa', role: 'Finance' }, { name: 'Mrs. Esther Darkwa', role: 'Finance' }, { name: 'Miss Gina', role: 'Finance' }] },
      { name: 'Organisers', people: [{ name: 'Elder Mark', role: 'Organiser' }, { name: 'Mr. Patrick', role: 'Organiser' }, { name: 'Brother Steven', role: 'Organiser' }, { name: 'Mrs. Janet Ama', role: 'Organiser' }, { name: 'Brother Gideon', role: 'Organiser' }, { name: 'Brother Arthur', role: 'Organiser' }] }
    ];
    const BASE_MEMBERS = TEAM_GROUPS.flatMap(group => group.people.map(person => person.name));

    let activeFilter = 'All';
    let logsSearchTerm = '';
    let logsDateFrom = '';
    let logsDateTo = '';
    let directorySearchTerm = '';
    let attendanceStatuses = {};
    let editingPhones = false;
    let cloudOperationQueue = Promise.resolve();
    let cloudSyncPromise = null;
    let phoneSyncPromise = null;
    let currentAdmin = null;
    let rollcallPushTimer = null;
    let pendingRollcallConflict = null;
    let pendingRecordConflict = null;
    const shownConflictIds = new Set();

    // Toast Notification System
    function showToast(message, type = 'success', duration = 3000) {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      
      const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warning' ? '⚠' : 'ℹ';
      toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${escapeHtml(message)}</span>`;
      
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px) scale(0.95)';
        setTimeout(() => toast.remove(), 250);
      }, duration);
    }

    // Floating how-to guide (note icon)
    let guideLastFocus = null;
    let guideBodyOverflow = '';

    function guideFocusable() {
      const panel = document.querySelector('#guide-overlay .guide-panel');
      if (!panel) return [];
      return [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.disabled && element.offsetParent !== null);
    }

    function openGuide() {
      const overlay = document.getElementById('guide-overlay');
      if (!overlay || !overlay.classList.contains('hidden')) return;
      guideLastFocus = document.activeElement;
      guideBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      overlay.classList.remove('hidden');
      document.getElementById('guide-close')?.focus();
    }

    function closeGuide() {
      const overlay = document.getElementById('guide-overlay');
      if (!overlay || overlay.classList.contains('hidden')) return;
      overlay.classList.add('hidden');
      document.body.style.overflow = guideBodyOverflow;
      if (guideLastFocus && document.contains(guideLastFocus)) guideLastFocus.focus();
      guideLastFocus = null;
    }

    function guideBackdrop(event) {
      if (event.target === event.currentTarget) closeGuide();
    }

    function guideKeydown(event) {
      const overlay = document.getElementById('guide-overlay');
      if (!overlay || overlay.classList.contains('hidden')) return;
      if (event.key === 'Escape') {
        closeGuide();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = guideFocusable();
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', guideKeydown);

    function readAuthSession() {
      try {
        const session = JSON.parse(sessionStorage.getItem(AUTH_SESSION_KEY) || 'null');
        return session && typeof session.token === 'string' && session.admin ? session : null;
      } catch {
        return null;
      }
    }

    function saveAuthSession(token, admin) {
      const session = { token, admin };
      sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
      sessionStorage.removeItem(PIN_SETUP_TOKEN_KEY);
      currentAdmin = admin;
      finishSignIn();
    }

    function finishSignIn() {
      sessionStorage.setItem('gemyfell_unlocked', 'true');
      document.getElementById('lock-screen').classList.add('hidden');
      document.getElementById('login-fields').classList.remove('hidden');
      document.getElementById('pin-setup-fields').classList.add('hidden');
      document.getElementById('header-session').classList.remove('hidden');
      document.getElementById('session-admin-name').textContent = currentAdmin ? currentAdmin.name : '';
      document.getElementById('session-role').textContent = currentAdmin ? roleLabel(currentAdmin.role) : '';
      document.getElementById('session-avatar').textContent = currentAdmin ? getInitials(currentAdmin.name) : '';
      document.getElementById('logout-button').classList.remove('hidden');
      applyRoleAccess();
      renderDashboard();
      updateCloudStatusFromLocal();
      if (navigator.onLine) {
        void syncCloudRecords();
        void syncCommitteePhones();
        void loadSharedRollCall();
      }
    }

    async function parseApiResponse(response) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error('The server returned an invalid response.');
      }
      if (!response.ok) {
        const error = new Error(payload?.error || `Request failed (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return payload;
    }

    async function loginAdmin() {
      const phone = document.getElementById('login-phone').value.trim();
      const credential = document.getElementById('login-credential').value;
      const errorBox = document.getElementById('pin-error');
      const button = document.getElementById('login-submit');
      if (!phone || !credential) {
        errorBox.textContent = 'Enter your phone number and PIN or temporary password.';
        return;
      }

      button.disabled = true;
      errorBox.textContent = '';
      try {
        const response = await fetch('/api/auth', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'login', phone, credential })
        });
        const payload = await parseApiResponse(response);
        if (payload.requiresPinSetup) {
          sessionStorage.setItem(PIN_SETUP_TOKEN_KEY, payload.token);
          sessionStorage.setItem('gemyfell_pending_admin', JSON.stringify(payload.admin));
          document.getElementById('login-fields').classList.add('hidden');
          document.getElementById('pin-setup-fields').classList.remove('hidden');
          document.getElementById('new-pin').focus();
          errorBox.textContent = '';
          return;
        }
        saveAuthSession(payload.token, payload.admin);
        document.getElementById('login-credential').value = '';
        showToast(`Welcome, ${payload.admin.name}.`, 'success');
      } catch (error) {
        errorBox.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    }

    async function completePinSetup() {
      const pin = document.getElementById('new-pin').value;
      const confirmation = document.getElementById('new-pin-confirm').value;
      const setupToken = sessionStorage.getItem(PIN_SETUP_TOKEN_KEY);
      const errorBox = document.getElementById('pin-error');
      if (!/^\d{4}$/.test(pin)) {
        errorBox.textContent = 'Choose a four-digit numeric PIN.';
        return;
      }
      if (pin !== confirmation) {
        errorBox.textContent = 'The PIN entries do not match.';
        return;
      }
      if (!setupToken) {
        errorBox.textContent = 'The temporary sign-in expired. Ask the superadmin for a new temporary password.';
        return;
      }

      try {
        const response = await fetch('/api/auth', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${setupToken}` },
          body: JSON.stringify({ action: 'set-pin', pin })
        });
        const payload = await parseApiResponse(response);
        saveAuthSession(payload.token, payload.admin);
        sessionStorage.removeItem('gemyfell_pending_admin');
        document.getElementById('new-pin').value = '';
        document.getElementById('new-pin-confirm').value = '';
        showToast('Your PIN is set. You are signed in.', 'success');
      } catch (error) {
        errorBox.textContent = error.message;
      }
    }

    function roleLabel(role) {
      return ({ superadmin: 'Superadmin', secretary: 'Secretary', disciplinary: 'Disciplinary', attendance: 'Attendance', viewer: 'Viewer' })[role] || 'Administrator';
    }

    function canReadRecordType(type) {
      if (!currentAdmin) return false;
      if (['superadmin', 'secretary', 'viewer'].includes(currentAdmin.role)) return true;
      if (currentAdmin.role === 'disciplinary') return type === 'Incident Report' || type === 'Meeting Minutes';
      return currentAdmin.role === 'attendance' && type === 'Attendance';
    }

    function canWriteRecordType(type) {
      if (!currentAdmin) return false;
      if (['superadmin', 'secretary'].includes(currentAdmin.role)) return true;
      if (currentAdmin.role === 'disciplinary') return type === 'Incident Report' || type === 'Meeting Minutes';
      return currentAdmin.role === 'attendance' && type === 'Attendance';
    }

    function applyRoleAccess() {
      if (!currentAdmin) return;
      const tabsByRole = {
        superadmin: ['home', 'team', 'roll', 'log', 'messages', 'logs'],
        secretary: ['home', 'team', 'roll', 'log', 'messages', 'logs'],
        disciplinary: ['home', 'team', 'log', 'messages', 'logs'],
        attendance: ['home', 'team', 'roll', 'logs'],
        viewer: ['home', 'team', 'logs']
      };
      const allowed = tabsByRole[currentAdmin.role] || ['team'];
      document.querySelectorAll('.nav [data-tab]').forEach(button => {
        button.classList.toggle('hidden', !allowed.includes(button.dataset.tab));
      });
      document.querySelectorAll('.tab-section').forEach(section => {
        const name = section.id.replace('tab-', '');
        if (!allowed.includes(name)) section.classList.add('hidden');
      });
      document.getElementById('admin-management').classList.toggle('hidden', currentAdmin.role !== 'superadmin');
      if (currentAdmin.role === 'superadmin') void loadAdminAccounts();

      const phoneToggle = document.getElementById('phone-toggle');
      if (phoneToggle) phoneToggle.classList.toggle('hidden', !canWriteDirectory());
      if (!canWriteDirectory() && editingPhones) {
        editingPhones = false;
        document.getElementById('phone-toggle-text').textContent = 'Edit Numbers';
      }

      const active = document.querySelector('.nav [data-tab].active');
      if (!active || !allowed.includes(active.dataset.tab)) {
        const first = document.querySelector(`.nav [data-tab="${allowed[0]}"]`);
        if (first) switchTab(allowed[0], first);
      }
    }

    function expireAdminSession(message = 'Your sign-in expired. Please sign in again.') {
      sessionStorage.removeItem(AUTH_SESSION_KEY);
      sessionStorage.removeItem(PIN_SETUP_TOKEN_KEY);
      sessionStorage.removeItem('gemyfell_pending_admin');
      sessionStorage.removeItem('gemyfell_unlocked');
      currentAdmin = null;
      document.getElementById('lock-screen').classList.remove('hidden');
      document.getElementById('login-fields').classList.remove('hidden');
      document.getElementById('pin-setup-fields').classList.add('hidden');
      document.getElementById('header-session').classList.add('hidden');
      document.getElementById('session-admin-name').textContent = '';
      document.getElementById('session-role').textContent = '';
      document.getElementById('session-avatar').textContent = '';
      document.getElementById('logout-button').classList.add('hidden');
      document.getElementById('pin-error').textContent = message;
      updateCloudStatus('authRequired');
    }

    async function logoutAdmin() {
      const session = readAuthSession();
      if (session?.token && navigator.onLine) {
        try {
          await fetch('/api/auth', {
            method: 'DELETE',
            cache: 'no-store',
            headers: { Authorization: `Bearer ${session.token}` }
          });
        } catch (error) {
          console.warn('Could not revoke server session during sign out:', error);
        }
      }
      expireAdminSession('Signed out. Enter your phone number and PIN to continue.');
    }

    async function initializeAdminSession() {
      const session = readAuthSession();
      if (!session) {
        document.getElementById('lock-screen').classList.remove('hidden');
        const setupToken = sessionStorage.getItem(PIN_SETUP_TOKEN_KEY);
        if (setupToken) {
          document.getElementById('login-fields').classList.add('hidden');
          document.getElementById('pin-setup-fields').classList.remove('hidden');
          document.getElementById('pin-error').textContent = 'Finish setting your PIN to complete sign-in.';
          return;
        }
        updateCloudStatus(navigator.onLine ? 'authRequired' : 'offline');
        return;
      }

      if (navigator.onLine) {
        try {
          const response = await fetch('/api/auth', {
            cache: 'no-store',
            headers: { Authorization: `Bearer ${session.token}` }
          });
          const payload = await parseApiResponse(response);
          currentAdmin = payload.admin;
          sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({ ...session, admin: payload.admin }));
        } catch (error) {
          if (error.status === 401) {
            expireAdminSession();
            return;
          }
          currentAdmin = session.admin;
          console.warn('Using the cached admin session while the server is unavailable:', error);
        }
      } else {
        currentAdmin = session.admin;
      }
      finishSignIn();
    }

    function safeRead(key, fallback) {
      try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : JSON.parse(value);
      } catch (error) {
        console.error(`Could not read ${key}:`, error);
        return fallback;
      }
    }

    function saveLocal(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        console.error(`Could not save ${key}:`, error);
        showToast('Storage error. Check device storage space.', 'error');
        return false;
      }
    }

    function getRecords() {
      const records = safeRead(RECORDS_KEY, []);
      return Array.isArray(records) ? records : [];
    }

    async function adminApi(method = 'GET', body = null) {
      const session = readAuthSession();
      if (!session?.token || currentAdmin?.role !== 'superadmin') {
        throw new Error('Superadmin access is required.');
      }
      const response = await fetch('/api/admins', {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${session.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      try {
        return await parseApiResponse(response);
      } catch (error) {
        if (error.status === 401) expireAdminSession();
        throw error;
      }
    }

    async function loadAdminAccounts() {
      if (currentAdmin?.role !== 'superadmin') return;
      const list = document.getElementById('admin-list');
      try {
        const payload = await adminApi();
        list.innerHTML = payload.admins.map(admin => `
          <div class="admin-account">
            <div>
              <strong>${escapeHtml(admin.name)}</strong>
              <div class="record-meta">${escapeHtml(admin.phone)} · ${admin.active ? 'Active' : 'Disabled'}</div>
            </div>
            ${admin.role === 'superadmin' ? `<strong>${roleLabel(admin.role)} (protected)</strong>` : `
              <select aria-label="Role for ${escapeHtml(admin.name)}" data-admin-role="${escapeHtml(admin.phone)}">
                ${['secretary', 'disciplinary', 'attendance', 'viewer'].map(role =>
                  `<option value="${role}" ${role === admin.role ? 'selected' : ''}>${roleLabel(role)}</option>`
                ).join('')}
              </select>
              <div class="toolbar">
                <button class="button-small secondary" data-admin-action="save-role" data-phone="${escapeHtml(admin.phone)}">Save Role</button>
                <button class="button-small gold" data-admin-action="reset-password" data-phone="${escapeHtml(admin.phone)}">New Temp Password</button>
                <button class="button-small ${admin.active ? 'danger' : 'whatsapp'}" data-admin-action="toggle-active" data-phone="${escapeHtml(admin.phone)}" data-active="${admin.active}">${admin.active ? 'Disable' : 'Enable'}</button>
              </div>
            `}
          </div>`).join('');
        list.querySelectorAll('[data-admin-action]').forEach(button => button.addEventListener('click', () => {
          const { adminAction, phone, active } = button.dataset;
          if (adminAction === 'save-role') void updateAdminRole(phone, list.querySelector(`[data-admin-role="${CSS.escape(phone)}"]`)?.value);
          if (adminAction === 'reset-password') void resetAdminPassword(phone);
          if (adminAction === 'toggle-active') void setAdminActive(phone, active !== 'true');
        }));
      } catch (error) {
        list.textContent = error.message || 'Could not load administrator accounts.';
      }
    }

    function showTemporaryCredential(password, name) {
      const result = document.getElementById('new-admin-result');
      result.classList.remove('hidden');
      result.innerHTML = `<strong>Temporary password for ${escapeHtml(name)} — shown once:</strong><br><code>${escapeHtml(password)}</code><br><button type="button" class="button-small secondary" onclick="copyTemporaryCredential('${escapeHtml(password)}')">Copy Password</button><p class="hint">Deliver this privately. It expires on first use and cannot be reused.</p>`;
      result.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    async function copyTemporaryCredential(password) {
      try {
        await navigator.clipboard.writeText(password);
        showToast('Temporary password copied. Share it privately.', 'success');
      } catch {
        showToast('Copy failed. Select the displayed password manually.', 'warning');
      }
    }

    async function createAdministrator(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const payload = await adminApi('POST', {
          action: 'create',
          name: data.get('name'),
          phone: data.get('phone'),
          role: data.get('role')
        });
        form.reset();
        showTemporaryCredential(payload.temporaryPassword, payload.admin.name);
        await loadAdminAccounts();
      } catch (error) {
        showToast(error.message, 'error');
      } finally {
        button.disabled = false;
      }
    }

    async function updateAdminRole(phone, role) {
      if (!role) return;
      try {
        await adminApi('PATCH', { phone, role });
        showToast('Administrator role updated. They must sign in again.', 'success');
        await loadAdminAccounts();
      } catch (error) {
        showToast(error.message, 'error');
      }
    }

    async function setAdminActive(phone, active) {
      try {
        await adminApi('PATCH', { phone, active });
        showToast(active ? 'Administrator account enabled.' : 'Administrator account disabled.', 'success');
        await loadAdminAccounts();
      } catch (error) {
        showToast(error.message, 'error');
      }
    }

    async function resetAdminPassword(phone) {
      if (!confirm('Create a new one-time password? Existing sessions will be signed out.')) return;
      try {
        const payload = await adminApi('POST', { action: 'reset-password', phone });
        const row = [...document.querySelectorAll('.admin-account')].find(item => item.textContent.includes(phone));
        const name = row?.querySelector('strong')?.textContent || phone;
        showTemporaryCredential(payload.temporaryPassword, name);
        showToast('New one-time password generated.', 'success');
      } catch (error) {
        showToast(error.message, 'error');
      }
    }

    function getPendingCloudDeletes() {
      const ids = safeRead(DELETED_RECORDS_KEY, []);
      return Array.isArray(ids) ? ids.map(String) : [];
    }

    function updateCloudStatus(state) {
      const indicator = document.getElementById('cloud-status');
      if (!indicator) return;
      const states = {
        syncing: ['☁️ Syncing Cloud…', ''],
        synced: ['☁️ Cloud Synced', 'synced'],
        offline: ['📴 Offline Mode', 'offline'],
        pending: ['☁️ Cloud Sync Pending', ''],
        authRequired: ['🔐 Sign In Required', 'offline'],
        authFailed: ['🔒 Session Expired', 'offline'],
        conflict: ['⚠️ Review Change Conflicts', 'offline']
      };
      const [text, className] = states[state] || states.pending;
      indicator.textContent = text;
      indicator.className = `cloud-status ${className}`;
    }

    function hasPendingCloudWork() {
      const deleteIds = getPendingCloudDeletes();
      const records = getRecords();
      const hasDeletes = deleteIds.some(id => {
        const record = records.find(item => String(item.id) === String(id));
        return !record || canWriteRecordType(record.type);
      });
      const hasUploads = records.some(record =>
        record._cloudSynced !== true &&
        canWriteRecordType(record.type) &&
        !deleteIds.includes(String(record.id))
      );
      return hasDeletes || hasUploads ||
        Object.keys(getPendingPhoneWrites()).length > 0 ||
        getPendingRollcallDates().length > 0 ||
        Boolean(pendingRecordConflict);
    }

    function updateCloudStatusFromLocal() {
      if (!navigator.onLine) {
        updateCloudStatus('offline');
        return;
      }
      if (!currentAdmin || !readAuthSession()?.token) {
        updateCloudStatus('authRequired');
        return;
      }
      updateCloudStatus(hasPendingCloudWork() ? 'pending' : 'synced');
    }

    function cloudErrorStatus(error) {
      if (error?.code === 'AUTH_REQUIRED') return 'authRequired';
      if (error?.code === 'AUTH_FAILED') return 'authFailed';
      if (error?.code === 'VERSION_CONFLICT') return 'conflict';
      return 'offline';
    }

    function getAdminToken() {
      return readAuthSession()?.token || '';
    }

    function enqueueCloudOperation(operation) {
      const next = cloudOperationQueue.then(operation, operation);
      cloudOperationQueue = next.catch(error => {
        console.error('Cloud sync operation failed:', error);
      });
      return next;
    }

    function cloudRecordPayload(record) {
      return {
        id: String(record.id),
        type: String(record.type || ''),
        date: String(record.date || ''),
        title: String(record.title || ''),
        status: record.status == null ? '' : String(record.status),
        recorder: record.recorder == null ? '' : String(record.recorder),
        version: Number(record.version) || 1,
        assignee: record.assignee || '',
        dueDate: record.dueDate || '',
        stage: record.stage || '',
        details: JSON.stringify({
          format: 'gemyfell-record-v2',
          details: String(record.details || ''),
          outcome: record.outcome || '',
          statuses: record.statuses || null,
          stageHistory: Array.isArray(record.stageHistory) ? record.stageHistory : []
        }),
        created_at: record.createdAt || record.created_at || new Date().toISOString()
      };
    }

    function cloudRowToRecord(row) {
      let payload = null;
      try {
        const parsed = JSON.parse(row.details || '');
        if (parsed && String(parsed.format || '').startsWith('gemyfell-record-v')) payload = parsed;
      } catch {
        // Older records may store plain text in the details column.
      }

      return {
        id: String(row.id),
        type: row.type || '',
        date: row.date || '',
        title: row.title || '',
        status: row.status || '',
        recorder: row.recorder || '',
        version: Number(row.version) || 1,
        assignee: row.assignee || '',
        dueDate: row.due_date || row.dueDate || '',
        stage: row.stage || '',
        details: payload ? payload.details : (row.details || ''),
        outcome: payload ? payload.outcome : '',
        statuses: payload ? payload.statuses : undefined,
        stageHistory: payload && Array.isArray(payload.stageHistory) ? payload.stageHistory : [],
        createdAt: row.created_at || '',
        _cloudSynced: true
      };
    }

    async function requestCloud(method, record, id) {
      const token = getAdminToken();
      if (!token) {
        const error = new Error('Please sign in again.');
        error.code = 'AUTH_REQUIRED';
        throw error;
      }
      const url = method === 'DELETE'
        ? `/api/records?id=${encodeURIComponent(String(id))}`
        : '/api/records';
      const options = {
        method,
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` }
      };
      if (record) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(record);
      }
      const response = await fetch(url, options);
      let result;
      try {
        result = await response.json();
      } catch {
        result = null;
      }
      if (!response.ok) {
        const error = new Error(result?.error || `Cloud request failed (${response.status}).`);
        if (response.status === 401) {
          error.code = 'AUTH_FAILED';
          expireAdminSession();
        }
        if (response.status === 409 && result?.code === 'VERSION_CONFLICT') {
          error.code = 'VERSION_CONFLICT';
          error.cloudRecord = result.record;
        }
        throw error;
      }
      return result;
    }

    async function requestAudit() {
      const token = getAdminToken();
      if (!token) {
        const error = new Error('Please sign in again.');
        error.code = 'AUTH_REQUIRED';
        throw error;
      }
      const response = await fetch('/api/audit?limit=100', {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` }
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(result?.error || `Audit request failed (${response.status}).`);
        if (response.status === 401) {
          error.code = 'AUTH_FAILED';
          expireAdminSession();
        }
        throw error;
      }
      if (!Array.isArray(result)) throw new Error('Cloud returned an invalid audit response.');
      return result;
    }

    async function loadAuditTrail(showResult = false) {
      const container = document.getElementById('audit-list');
      if (!container) return;
      if (!currentAdmin || !getAdminToken()) {
        container.innerHTML = '<p class="hint">Sign in to view the record activity log.</p>';
        return;
      }
      try {
        const rows = (await requestAudit()).filter(row => canReadRecordType(row.recordType));
        if (!rows.length) {
          container.innerHTML = '<p class="hint">No record activity has been logged yet.</p>';
          return;
        }
        container.innerHTML = rows.map(row => `
          <div class="audit-item">
            <span class="audit-action ${escapeHtml(row.action)}">${escapeHtml(row.action)}</span>
            <strong>${escapeHtml(row.actorName)}</strong>
            <span class="hint">${escapeHtml(roleLabel(row.actorRole))} · ${escapeHtml(new Date(row.createdAt).toLocaleString())}</span>
            <div>${escapeHtml(row.detail || row.recordType)}</div>
          </div>`).join('');
      } catch (error) {
        console.warn('Audit trail unavailable:', error);
        container.innerHTML = `<p class="hint">${error.code === 'AUTH_FAILED'
          ? 'Your session expired. Please sign in again.'
          : 'The audit trail is unavailable right now.'}</p>`;
        if (showResult) showToast('Audit trail unavailable.', 'warning');
      }
    }

    function showRecordConflict(local, cloud) {
      if (!local || !cloud) return;
      const id = String(local.id || cloud.id);
      if (shownConflictIds.has(id)) return;
      shownConflictIds.add(id);
      pendingRecordConflict = { local, cloud };
      const banner = document.getElementById('conflict-banner');
      if (!banner) return;
      banner.innerHTML = `
        <strong>Change conflict on ${escapeHtml(local.title || cloud.title || 'a record')}</strong>
        <span>This record was also edited on another device. Choose which copy to keep. Nothing is lost until you choose.</span>
        <div class="toolbar">
          <button class="gold" type="button" onclick="resolveRecordConflict('mine')">Keep my copy</button>
          <button class="secondary" type="button" onclick="resolveRecordConflict('cloud')">Use cloud copy</button>
          <button class="button-small secondary" type="button" onclick="dismissRecordConflict()">Review later</button>
        </div>`;
      banner.classList.remove('hidden');
      const logs = document.getElementById('tab-logs');
      if (logs && logs.classList.contains('hidden')) openTab('logs');
      banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function dismissRecordConflict() {
      pendingRecordConflict = null;
      const banner = document.getElementById('conflict-banner');
      if (!banner) return;
      banner.classList.add('hidden');
      banner.innerHTML = '';
    }

    function resolveRecordConflict(choice) {
      const conflict = pendingRecordConflict;
      if (!conflict) return;
      const records = getRecords();
      const index = records.findIndex(record => String(record.id) === String(conflict.local.id));
      if (choice === 'cloud') {
        const cloudCopy = { ...conflict.cloud, _cloudSynced: true };
        if (index >= 0) records[index] = cloudCopy;
        else records.unshift(cloudCopy);
        saveLocal(RECORDS_KEY, records);
        showToast('The cloud copy is now on this device.', 'success');
      } else if (choice === 'mine') {
        const myCopy = {
          ...conflict.local,
          version: Number(conflict.cloud.version) || 1,
          _cloudSynced: false
        };
        if (index >= 0) records[index] = myCopy;
        else records.unshift(myCopy);
        if (saveLocal(RECORDS_KEY, records)) void queueRecordForCloud(myCopy);
        showToast('Your copy will be sent to the cloud.', 'success');
      }
      dismissRecordConflict();
      renderRecords();
      renderDashboard();
    }

    function updateRecordVersion(id, version) {
      const nextVersion = Number(version) || 1;
      const records = getRecords();
      const index = records.findIndex(record => String(record.id) === String(id));
      if (index < 0) return true;
      if (Number(records[index].version) === nextVersion) return true;
      records[index] = { ...records[index], version: nextVersion };
      return saveLocal(RECORDS_KEY, records);
    }

    function markRecordCloudSynced(id) {
      if (getPendingCloudDeletes().includes(String(id))) return false;
      const records = getRecords();
      const index = records.findIndex(record => String(record.id) === String(id));
      if (index < 0) return true;
      records[index] = { ...records[index], _cloudSynced: true };
      return saveLocal(RECORDS_KEY, records);
    }

    function removeCloudDeleteMarker(id) {
      return saveLocal(
        DELETED_RECORDS_KEY,
        getPendingCloudDeletes().filter(pendingId => pendingId !== String(id))
      );
    }

    async function deleteCloudRecordDirect(id) {
      await requestCloud('DELETE', null, id);
      if (!removeCloudDeleteMarker(id)) throw new Error('Could not clear the local cloud-delete queue.');
    }

    function queueRecordForCloud(record) {
      return enqueueCloudOperation(async () => {
        const id = String(record.id);
        try {
          if (getPendingCloudDeletes().includes(id)) {
            await deleteCloudRecordDirect(id);
          } else {
            updateCloudStatus('syncing');
            const result = await requestCloud('POST', cloudRecordPayload(record));
            if (result?.version && !updateRecordVersion(id, result.version)) {
              updateCloudStatus('offline');
              return false;
            }
            if (getPendingCloudDeletes().includes(id)) {
              await deleteCloudRecordDirect(id);
            } else if (!markRecordCloudSynced(id)) {
              updateCloudStatus('offline');
              return false;
            }
          }
          updateCloudStatusFromLocal();
          return true;
        } catch (error) {
          console.warn('Record remains saved locally; cloud upload failed:', error);
          if (error.code === 'VERSION_CONFLICT') showRecordConflict(record, error.cloudRecord);
          updateCloudStatus(cloudErrorStatus(error));
          return false;
        }
      });
    }

    function syncCloudRecords(showResult = false) {
      if (cloudSyncPromise) return cloudSyncPromise;
      cloudSyncPromise = enqueueCloudOperation(async () => {
        if (!currentAdmin || !getAdminToken()) {
          updateCloudStatus('authRequired');
          if (showResult) showToast('Sign in before syncing cloud records.', 'warning');
          return false;
        }
        updateCloudStatus('syncing');
        let hasFailures = false;
        try {
          for (const id of getPendingCloudDeletes()) {
            try {
              await deleteCloudRecordDirect(id);
            } catch (error) {
              hasFailures = true;
              console.warn('Cloud delete remains queued:', error);
            }
          }

          const pendingDeleteIds = new Set(getPendingCloudDeletes());
          const pendingRecords = getRecords().filter(record =>
            record._cloudSynced !== true &&
            !pendingDeleteIds.has(String(record.id)) &&
            canWriteRecordType(record.type)
          );
          for (const record of pendingRecords) {
            try {
              const result = await requestCloud('POST', cloudRecordPayload(record));
              if (result?.version && !updateRecordVersion(record.id, result.version)) hasFailures = true;
              if (!markRecordCloudSynced(record.id)) hasFailures = true;
            } catch (error) {
              hasFailures = true;
              console.warn('Record remains saved locally; cloud upload failed:', error);
              if (error.code === 'VERSION_CONFLICT') showRecordConflict(record, error.cloudRecord);
            }
          }

          const cloudRows = await requestCloud('GET');
          if (!Array.isArray(cloudRows)) throw new Error('Cloud returned an invalid records response.');

          const deletedIds = new Set(getPendingCloudDeletes());
          const merged = new Map();
          cloudRows.forEach(row => {
            const record = cloudRowToRecord(row);
            if (!deletedIds.has(record.id) && canReadRecordType(record.type)) merged.set(record.id, record);
          });
          getRecords().forEach(record => {
            const id = String(record.id);
            if (canReadRecordType(record.type) && !deletedIds.has(id) && (!merged.has(id) || record._cloudSynced !== true)) {
              merged.set(id, record);
            }
          });

          const mergedRecords = [...merged.values()].sort((left, right) =>
            Date.parse(right.createdAt || right.created_at || '') -
            Date.parse(left.createdAt || left.created_at || '')
          );
          if (!saveLocal(RECORDS_KEY, mergedRecords)) {
            throw new Error('Could not update the local records cache.');
          }
          renderRecords();
          updateCloudStatus(hasFailures ? 'offline' : 'synced');
          if (showResult) {
            showToast(hasFailures
              ? 'Some records remain queued on this device.'
              : 'Cloud records refreshed successfully.', hasFailures ? 'warning' : 'success');
          }
          return !hasFailures;
        } catch (error) {
          console.warn('Cloud refresh failed; local records are unchanged:', error);
          updateCloudStatus(cloudErrorStatus(error));
          if (showResult) {
            showToast(error.code === 'AUTH_FAILED'
              ? 'Your session expired. Please sign in again.'
              : 'Cloud unavailable. Your local records remain available.', 'warning');
          }
          return false;
        }
      }).finally(() => {
        cloudSyncPromise = null;
      });
      return cloudSyncPromise;
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function openTab(name) {
      const button = document.querySelector(`.nav [data-tab="${name}"]`);
      if (button && !button.classList.contains('hidden')) switchTab(name, button);
    }

    function switchTab(name, button) {
      document.querySelectorAll('.tab-section').forEach(section => section.classList.add('hidden'));
      const target = document.getElementById(`tab-${name}`);
      if (target) {
        target.classList.remove('hidden');
        // Re-trigger fade-in animation
        target.style.animation = 'none';
        void target.offsetWidth;
        target.style.animation = '';
      }
      document.querySelectorAll('.nav button').forEach(item => item.classList.toggle('active', item === button));
      if (name === 'logs') {
        renderRecords();
        void syncCloudRecords();
        void loadAuditTrail();
      }
      if (name === 'home') renderDashboard();
      if (name === 'team' && !editingPhones && navigator.onLine) void syncCommitteePhones();
      if (name === 'roll') onRollDateChange();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function canWriteDirectory() {
      return !!currentAdmin && ['superadmin', 'secretary'].includes(currentAdmin.role);
    }

    function getPendingPhoneWrites() {
      const writes = safeRead(PENDING_PHONE_WRITES_KEY, {});
      if (!writes || typeof writes !== 'object' || Array.isArray(writes)) return {};
      const clean = {};
      Object.entries(writes).forEach(([name, entry]) => {
        if (BASE_MEMBERS.includes(name) && entry && typeof entry.phone === 'string') clean[name] = entry;
      });
      return clean;
    }

    async function phoneRequest(method, body = null) {
      const token = getAdminToken();
      if (!token) {
        const error = new Error('Please sign in again.');
        error.code = 'AUTH_REQUIRED';
        throw error;
      }
      const options = {
        method,
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` }
      };
      if (body) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      const response = await fetch('/api/phones', options);
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(result?.error || `Directory sync failed (${response.status}).`);
        if (response.status === 401) {
          error.code = 'AUTH_FAILED';
          expireAdminSession();
        }
        throw error;
      }
      return result;
    }

    function syncCommitteePhones(showResult = false) {
      if (phoneSyncPromise) return phoneSyncPromise;
      phoneSyncPromise = enqueueCloudOperation(async () => {
        if (!currentAdmin || !getAdminToken()) return false;
        if (!navigator.onLine) {
          updateCloudStatus('offline');
          return false;
        }
        updateCloudStatus('syncing');
        let hasFailures = false;
        try {
          const writes = getPendingPhoneWrites();
          for (const [name, entry] of Object.entries(writes)) {
            try {
              await phoneRequest('POST', { name, phone: entry.phone });
              const remaining = getPendingPhoneWrites();
              if (remaining[name]?.updatedAt === entry.updatedAt) {
                delete remaining[name];
                if (!saveLocal(PENDING_PHONE_WRITES_KEY, remaining)) {
                  hasFailures = true;
                  break;
                }
              }
            } catch (error) {
              hasFailures = true;
              console.warn('Phone number remains queued:', error);
            }
          }
          if (hasFailures) {
            updateCloudStatus('offline');
            if (showResult) showToast('Some directory changes remain queued on this device.', 'warning');
            return false;
          }

          const cloudPhones = await phoneRequest('GET');
          if (!cloudPhones || typeof cloudPhones !== 'object' || Array.isArray(cloudPhones)) {
            throw new Error('Cloud returned an invalid directory response.');
          }
          const merged = {};
          Object.entries(cloudPhones).forEach(([name, phone]) => {
            if (BASE_MEMBERS.includes(name) && typeof phone === 'string' && /^\+?\d{7,15}$/.test(phone)) merged[name] = phone;
          });
          Object.entries(getPendingPhoneWrites()).forEach(([name, entry]) => {
            if (entry.phone) merged[name] = entry.phone;
            else delete merged[name];
          });
          if (!saveLocal(PHONE_KEY, merged)) {
            throw new Error('Could not update the local directory cache.');
          }
          if (!editingPhones) renderDirectory();
          updateCloudStatusFromLocal();
          if (showResult) showToast('Committee directory refreshed from the cloud.', 'success');
          return true;
        } catch (error) {
          console.warn('Directory sync failed; local numbers are unchanged:', error);
          updateCloudStatus(cloudErrorStatus(error));
          if (showResult) {
            showToast(error.code === 'AUTH_FAILED'
              ? 'Your session expired. Please sign in again.'
              : 'Directory sync unavailable. Local numbers remain available.', 'warning');
          }
          return false;
        }
      }).finally(() => {
        phoneSyncPromise = null;
      });
      return phoneSyncPromise;
    }

    // Shared roll call — one attendance sheet per date, synced across devices
    function getSharedRollcalls() {
      const data = safeRead(ROLLCALLS_KEY, {});
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    }

    function getPendingRollcallDates() {
      const dates = safeRead(PENDING_ROLLCALL_KEY, []);
      return Array.isArray(dates) ? [...new Set(dates.map(String))] : [];
    }

    function saveSharedRollcall(date, entry, pending = true) {
      const all = getSharedRollcalls();
      all[date] = entry;
      if (!saveLocal(ROLLCALLS_KEY, all)) return false;
      const dates = getPendingRollcallDates();
      const position = dates.indexOf(date);
      if (pending && position < 0) dates.push(date);
      if (!pending && position >= 0) dates.splice(position, 1);
      return saveLocal(PENDING_ROLLCALL_KEY, dates);
    }

    function updateRollCallStatus(text) {
      const indicator = document.getElementById('rollcall-status');
      if (indicator) indicator.textContent = text;
    }

    function currentRollDate() {
      return document.getElementById('roll-date')?.value || localDateValue();
    }

    async function rollcallRequest(method, body = null) {
      const token = getAdminToken();
      if (!token) {
        const error = new Error('Please sign in again.');
        error.code = 'AUTH_REQUIRED';
        throw error;
      }
      const url = method === 'GET'
        ? `/api/rollcall?date=${encodeURIComponent(body.date)}`
        : '/api/rollcall';
      const options = {
        method,
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` }
      };
      if (body && method === 'POST') {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      const response = await fetch(url, options);
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(result?.error || `Roll call sync failed (${response.status}).`);
        if (response.status === 401) {
          error.code = 'AUTH_FAILED';
          expireAdminSession();
        }
        if (response.status === 409 && result?.code === 'VERSION_CONFLICT') {
          error.code = 'VERSION_CONFLICT';
          error.rollCall = result.rollCall;
        }
        throw error;
      }
      return result;
    }

    function showRollCallConflict(date, cloud) {
      pendingRollcallConflict = { date, cloud };
      const banner = document.getElementById('rollcall-conflict');
      if (!banner || !cloud) return;
      banner.innerHTML = `
        <strong>Roll call changed on another device</strong>
        <span>${escapeHtml(date)} was updated elsewhere. Choose which copy to keep for this date.</span>
        <div class="toolbar">
          <button class="gold" type="button" onclick="resolveRollCallConflict('mine')">Keep my copy</button>
          <button class="secondary" type="button" onclick="resolveRollCallConflict('cloud')">Use cloud copy</button>
        </div>`;
      banner.classList.remove('hidden');
    }

    function dismissRollCallConflict() {
      pendingRollcallConflict = null;
      const banner = document.getElementById('rollcall-conflict');
      if (!banner) return;
      banner.classList.add('hidden');
      banner.innerHTML = '';
    }

    function resolveRollCallConflict(choice) {
      const conflict = pendingRollcallConflict;
      if (!conflict) return;
      const cached = getSharedRollcalls()[conflict.date] || { statuses: {}, version: 0 };
      const chosen = choice === 'cloud'
        ? { statuses: conflict.cloud.statuses || {}, version: Number(conflict.cloud.version) || 1, updatedAt: conflict.cloud.updatedAt || '' }
        : { statuses: cached.statuses, version: Number(conflict.cloud.version) || 1, updatedAt: '' };
      saveSharedRollcall(conflict.date, chosen, choice !== 'cloud');
      dismissRollCallConflict();
      if (conflict.date === currentRollDate()) {
        attendanceStatuses = { ...chosen.statuses };
        renderRollCall();
      }
      if (choice === 'cloud') {
        updateRollCallStatus('Cloud copy loaded for this date.');
        showToast('The shared roll call is now on this device.', 'success');
      } else {
        updateRollCallStatus('Your copy will be sent to the cloud.');
        void enqueueCloudOperation(() => pushSharedRollCall(conflict.date, true));
      }
      updateCloudStatusFromLocal();
    }

    async function loadSharedRollCall(showResult = false) {
      if (!currentAdmin || !getAdminToken()) {
        updateRollCallStatus('Sign in to load the shared roll call.');
        return false;
      }
      const date = currentRollDate();
      try {
        const state = await rollcallRequest('GET', { date });
        const pending = getPendingRollcallDates().includes(date);
        const cached = getSharedRollcalls()[date];
        if (!pending) {
          attendanceStatuses = { ...(state.statuses || {}) };
          saveSharedRollcall(date, state, false);
          renderRollCall();
          updateRollCallStatus(state.updatedAt
            ? `Shared roll call loaded · updated ${new Date(state.updatedAt).toLocaleString()}`
            : `No shared roll call yet for ${date}. Your marks are ready.`);
        } else {
          updateRollCallStatus('Local changes are queued. They will be sent when you sync.');
        }
        if (showResult) showToast('Shared roll call checked.', 'success');
        return true;
      } catch (error) {
        console.warn('Shared roll call could not be loaded:', error);
        updateRollCallStatus(error.code === 'AUTH_FAILED'
          ? 'Your session expired. Please sign in again.'
          : 'Cloud unavailable. Roll call stays on this device.');
        if (showResult) showToast('Shared roll call unavailable right now.', 'warning');
        return false;
      }
    }

    async function pushSharedRollCall(date, showResult = false) {
      if (!currentAdmin || !getAdminToken() || !navigator.onLine) {
        updateRollCallStatus('Roll call stays on this device until you are online.');
        return false;
      }
      const cached = getSharedRollcalls()[date];
      if (!cached || !getPendingRollcallDates().includes(date)) return true;
      try {
        const result = await rollcallRequest('POST', {
          date,
          statuses: cached.statuses || {},
          version: Number(cached.version) || 0
        });
        saveSharedRollcall(date, {
          ...cached,
          version: Number(result.version) || 1,
          updatedAt: new Date().toISOString()
        }, false);
        updateRollCallStatus(`Shared roll call synced for ${date}.`);
        if (showResult) showToast('Roll call synced with the cloud.', 'success');
        updateCloudStatusFromLocal();
        return true;
      } catch (error) {
        console.warn('Roll call remains queued on this device:', error);
        if (error.code === 'VERSION_CONFLICT') {
          showRollCallConflict(date, error.rollCall);
          updateCloudStatus('conflict');
        } else {
          updateCloudStatus(cloudErrorStatus(error));
        }
        updateRollCallStatus('Roll call changed on another device. Choose which copy to keep.');
        if (showResult) showToast('Roll call could not be shared yet.', 'warning');
        return false;
      }
    }

    function markRollCallDirty() {
      const date = currentRollDate();
      const cached = getSharedRollcalls()[date] || { version: 0, statuses: {}, updatedAt: '' };
      const statuses = {};
      allRollMembers().forEach(name => {
        statuses[name] = STATUSES.includes(attendanceStatuses[name]) ? attendanceStatuses[name] : 'Absent';
      });
      saveSharedRollcall(date, { ...cached, statuses }, true);
      updateRollCallStatus('Roll call changed — sharing…');
      updateCloudStatusFromLocal();
      clearTimeout(rollcallPushTimer);
      rollcallPushTimer = setTimeout(() => {
        void enqueueCloudOperation(() => pushSharedRollCall(date));
      }, 700);
    }

    function onRollDateChange() {
      const date = currentRollDate();
      const cached = getSharedRollcalls()[date];
      attendanceStatuses = cached ? { ...cached.statuses } : {};
      renderRollCall();
      if (navigator.onLine) void loadSharedRollCall();
      else updateRollCallStatus('Offline — marks stay on this device until you sync.');
    }

    function syncSharedRollCalls(showResult = false) {
      return enqueueCloudOperation(async () => {
        if (!currentAdmin || !getAdminToken() || !navigator.onLine) return false;
        let ok = true;
        for (const date of getPendingRollcallDates()) {
          if (!(await pushSharedRollCall(date))) ok = false;
        }
        const rollTab = document.getElementById('tab-roll');
        if (rollTab && !rollTab.classList.contains('hidden')) {
          if (!(await loadSharedRollCall(false))) ok = false;
        }
        if (showResult) {
          showToast(ok ? 'Roll calls are up to date.' : 'Some roll call changes remain on this device.', ok ? 'success' : 'warning');
        }
        return ok;
      });
    }

    async function syncAllCloud(showResult = false) {
      const [recordsOk, phonesOk, rollcallsOk] = await Promise.all([
        syncCloudRecords(showResult),
        syncCommitteePhones(false),
        syncSharedRollCalls(false)
      ]);
      if (showResult && !phonesOk) {
        showToast('Some directory changes remain queued on this device.', 'warning');
      }
      if (showResult && !rollcallsOk) {
        showToast('Some roll call changes remain queued on this device.', 'warning');
      }
      void loadAuditTrail();
      return recordsOk && phonesOk && rollcallsOk;
    }

    function phoneMap() {
      const phones = safeRead(PHONE_KEY, {});
      return phones && typeof phones === 'object' && !Array.isArray(phones) ? phones : {};
    }

    function normalizePhone(value) {
      const clean = String(value || '').trim().replace(/[^\d+]/g, '');
      return clean.startsWith('+') ? `+${clean.slice(1).replace(/\+/g, '')}` : clean.replace(/\+/g, '');
    }

    function getInitials(name) {
      const parts = name.trim().split(/\s+/);
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    function filterDirectory(query) {
      directorySearchTerm = (query || '').toLowerCase().trim();
      renderDirectory();
    }

    function renderDirectory() {
      const phones = phoneMap();
      const term = directorySearchTerm;

      const filteredGroups = TEAM_GROUPS.map(group => {
        const matchingPeople = group.people.filter(person => {
          if (!term) return true;
          return person.name.toLowerCase().includes(term) || (person.role && person.role.toLowerCase().includes(term));
        });
        return { name: group.name, people: matchingPeople };
      }).filter(group => group.people.length > 0);

      const container = document.getElementById('team-directory');
      if (filteredGroups.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <p>No committee members match "${escapeHtml(term)}".</p>
          </div>`;
        return;
      }

      container.innerHTML = filteredGroups.map(group => `
        <div class="team-group">
          <p class="team-heading">${escapeHtml(group.name)}</p>
          <div class="directory-grid">
            ${group.people.map(person => {
              const rawPhone = phones[person.name] || '+233000000000';
              const number = normalizePhone(rawPhone) || '+233000000000';
              const initials = getInitials(person.name);
              return `
              <div class="person-card${editingPhones ? ' editing' : ''}">
                <div class="person-main">
                  <div class="person-avatar">${escapeHtml(initials)}</div>
                  <div class="person-info">
                    <span class="person-name" title="${escapeHtml(person.name)}">${escapeHtml(person.name)}</span>
                    ${person.role ? `<span class="person-role">${escapeHtml(person.role)}</span>` : '<span class="person-role">Committee Member</span>'}
                  </div>
                </div>
                <a class="call-link" href="tel:${escapeHtml(number)}" aria-label="Call ${escapeHtml(person.name)}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                  Call
                </a>
                ${editingPhones ? `
                <div class="phone-editor">
                  <input type="tel" value="${escapeHtml(rawPhone)}" data-phone-name="${escapeHtml(person.name)}" aria-label="Phone number for ${escapeHtml(person.name)}" placeholder="+233..." />
                  <button class="button-small" onclick="savePhone('${escapeHtml(person.name)}', this)">Save</button>
                </div>` : ''}
              </div>`;
            }).join('')}
          </div>
        </div>`).join('');
    }

    function togglePhoneEditor() {
      if (!canWriteDirectory()) {
        showToast('Only secretaries and superadmins can edit directory numbers.', 'warning');
        return;
      }
      editingPhones = !editingPhones;
      document.getElementById('phone-toggle-text').textContent = editingPhones ? 'Done Editing' : 'Edit Numbers';
      renderDirectory();
      if (editingPhones && navigator.onLine) void syncCommitteePhones();
    }

    function savePhone(name, button) {
      if (!canWriteDirectory()) {
        showToast('Only secretaries and superadmins can edit directory numbers.', 'warning');
        return;
      }
      const input = button.parentElement.querySelector('input');
      const phone = normalizePhone(input.value);
      if (phone && !/^\+?\d{7,15}$/.test(phone)) {
        showToast('Enter a valid phone number (e.g. +233XXXXXXXXX)', 'warning');
        return;
      }
      const phones = phoneMap();
      if (phone) phones[name] = phone;
      else delete phones[name];
      if (!saveLocal(PHONE_KEY, phones)) return;
      const writes = getPendingPhoneWrites();
      writes[name] = { phone, updatedAt: new Date().toISOString() };
      if (!saveLocal(PENDING_PHONE_WRITES_KEY, writes)) return;
      showToast(`Phone number for ${name} saved${navigator.onLine ? '; syncing to cloud' : ' offline'}`, 'success');
      renderDirectory();
      updateCloudStatusFromLocal();
      if (navigator.onLine) void syncCommitteePhones();
    }

    function allRollMembers() {
      const extras = safeRead(EXTRA_MEMBERS_KEY, []);
      return [...BASE_MEMBERS, ...(Array.isArray(extras) ? extras.filter(name => typeof name === 'string') : [])];
    }

    function localDateValue(date = new Date()) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    function renderRollCall() {
      const dateInput = document.getElementById('roll-date');
      if (!dateInput.value) dateInput.value = localDateValue();
      const members = allRollMembers();
      members.forEach(name => { if (!attendanceStatuses[name]) attendanceStatuses[name] = 'Absent'; });
      attendanceStatuses = Object.fromEntries(members.map(name => [name, attendanceStatuses[name] || 'Absent']));
      
      document.getElementById('roll-members').innerHTML = members.map((name, index) => `
        <div class="member-row">
          <span class="member-name">${escapeHtml(name)}</span>
          <div class="status-pills">
            ${STATUSES.map(status => `
              <button type="button" class="status-pill ${attendanceStatuses[name] === status ? 'selected' : ''}" data-status="${status}" onclick="setAttendanceStatus(${index}, '${status}')">
                ${status}
              </button>`).join('')}
          </div>
        </div>`).join('');
    }

    function setAttendanceStatus(index, status) {
      const name = allRollMembers()[index];
      if (!name || !STATUSES.includes(status)) return;
      attendanceStatuses[name] = status;
      renderRollCall();
      markRollCallDirty();
    }

    function quickMarkAllPresent() {
      const members = allRollMembers();
      members.forEach(name => { attendanceStatuses[name] = 'Present'; });
      renderRollCall();
      markRollCallDirty();
      showToast('All members marked as Present', 'info');
    }

    function addExtraMember() {
      const name = prompt('Enter the extra member’s full name:');
      if (!name || !name.trim()) return;
      const clean = name.trim();
      const members = allRollMembers();
      if (members.some(member => member.toLowerCase() === clean.toLowerCase())) {
        showToast('That member is already on the roll call.', 'warning');
        return;
      }
      const extras = safeRead(EXTRA_MEMBERS_KEY, []);
      extras.push(clean);
      if (saveLocal(EXTRA_MEMBERS_KEY, extras)) {
        attendanceStatuses[clean] = 'Absent';
        renderRollCall();
        markRollCallDirty();
        showToast(`${clean} added to roll call`, 'success');
      }
    }

    function attendanceRecord() {
      const members = allRollMembers();
      const statuses = {};
      members.forEach(name => { statuses[name] = STATUSES.includes(attendanceStatuses[name]) ? attendanceStatuses[name] : 'Absent'; });
      return {
        id: `attendance-${Date.now()}`,
        type: 'Attendance',
        date: document.getElementById('roll-date').value || localDateValue(),
        title: document.getElementById('roll-event').value.trim() || 'Committee Session',
        statuses,
        details: attendanceDetails(statuses)
      };
    }

    function attendanceCounts(statuses) {
      return Object.fromEntries(STATUSES.map(status => [status, Object.values(statuses).filter(value => value === status).length]));
    }

    function attendanceDetails(statuses) {
      return STATUSES.map(status => `${status} (${Object.values(statuses).filter(value => value === status).length}): ${Object.entries(statuses).filter(([, value]) => value === status).map(([name]) => name).join(', ') || 'None'}`).join('\n');
    }

    function attendanceMessage(record) {
      const counts = attendanceCounts(record.statuses);
      return `*GEMYFELL @20 ANNIVERSARY — ATTENDANCE*\n*Event:* ${record.title}\n*Date:* ${record.date}\n*Total:* ${Object.keys(record.statuses).length}\n\n${STATUSES.map(status => `*${status}: ${counts[status]}*\n${Object.entries(record.statuses).filter(([, value]) => value === status).map(([name]) => `• ${name}`).join('\n') || '• None'}`).join('\n\n')}`;
    }

    function saveRollCall() {
      const record = attendanceRecord();
      if (storeRecord(record)) {
        markRollCallDirty();
        if (navigator.onLine) void enqueueCloudOperation(() => pushSharedRollCall(record.date));
        showToast('Roll call saved and queued for sharing.', 'success');
      }
    }

    function shareAttendance() {
      const record = attendanceRecord();
      window.open(`https://wa.me/?text=${encodeURIComponent(attendanceMessage(record))}`, '_blank', 'noopener');
    }

    function setLogType(type) {
      const minutes = type === 'Meeting Minutes';
      document.getElementById('incident-fields').classList.toggle('hidden', minutes);
      document.getElementById('minutes-fields').classList.toggle('hidden', !minutes);
    }

    // Structured minutes builder
    function renumberAgendaItems() {
      document.querySelectorAll('#agenda-list .agenda-item').forEach((item, index) => {
        const label = item.querySelector('.agenda-head span');
        if (label) label.textContent = `Item ${index + 1}`;
      });
    }

    function addAgendaItem(data = {}) {
      const list = document.getElementById('agenda-list');
      if (!list) return;
      const item = document.createElement('div');
      item.className = 'agenda-item';
      item.innerHTML = `
        <div class="agenda-head">
          <span>Item</span>
          <button class="agenda-remove" type="button" onclick="removeAgendaItem(this)">Remove</button>
        </div>
        <label>Topic / Decision</label>
        <input class="agenda-topic" type="text" placeholder="e.g. Rehearsal" value="${escapeHtml(data.topic || '')}" />
        <label>Details</label>
        <textarea class="agenda-detail" rows="2" placeholder="What was agreed">${escapeHtml(data.detail || '')}</textarea>
        <label>Who &amp; When</label>
        <input class="agenda-action" type="text" placeholder="e.g. Mark and Patrick - before Wednesday rehearsal" value="${escapeHtml(data.action || '')}" />`;
      list.appendChild(item);
      renumberAgendaItems();
    }

    function removeAgendaItem(button) {
      button.closest('.agenda-item')?.remove();
      renumberAgendaItems();
    }

    function getAgendaItems() {
      return [...document.querySelectorAll('#agenda-list .agenda-item')].map(item => ({
        topic: item.querySelector('.agenda-topic')?.value.trim() || '',
        detail: item.querySelector('.agenda-detail')?.value.trim() || '',
        action: item.querySelector('.agenda-action')?.value.trim() || ''
      })).filter(item => item.topic || item.detail || item.action);
    }

    function clearAgendaItems() {
      const list = document.getElementById('agenda-list');
      if (!list) return;
      list.innerHTML = '';
      addAgendaItem();
    }

    function formatMeetingDate(value) {
      if (!value) return localDateValue();
      const date = new Date(`${value}T00:00:00`);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
    }

    function formatMeetingTime(value) {
      if (!value) return '';
      const [hours, minutes] = value.split(':').map(Number);
      if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return value;
      const suffix = hours >= 12 ? 'PM' : 'AM';
      return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${suffix}`;
    }

    function valueOf(id) {
      return document.getElementById(id)?.value.trim() || '';
    }

    function buildMinutesDetails() {
      const agenda = getAgendaItems();
      const notes = valueOf('min-notes');
      const time = formatMeetingTime(valueOf('min-time'));
      const lines = [`Date: ${formatMeetingDate(valueOf('min-date'))}${time ? ` | Time: ${time}` : ''}`];
      const place = valueOf('min-place');
      if (place) lines.push(`Place: ${place}`);
      lines.push(`By: ${valueOf('min-recorded-by')}`);

      lines.push('', '1. Attendance');
      lines.push(`Present: ${valueOf('min-present') || 'Not recorded'}`);
      const apology = valueOf('min-apology');
      if (apology) lines.push(`Absent with apology: ${apology}`);

      lines.push('', '2. Opening');
      const opening = valueOf('min-opening');
      if (opening) lines.push(`Prayer: ${opening}`);
      lines.push('Chairman welcomed all.');

      lines.push('', '3. Last minutes');
      lines.push(valueOf('min-last') || 'Read and adopted.');

      lines.push('', '4. Decisions');
      agenda.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.topic}${item.detail ? `: ${item.detail}` : ''}`);
        if (item.action) lines.push(`   Who: ${item.action}`);
      });

      let section = 5;
      if (notes) {
        lines.push('', `${section}. Other Matters`);
        lines.push(notes);
        section += 1;
      }
      lines.push('', `${section}. Close`);
      const next = valueOf('min-next');
      if (next) lines.push(`Next meeting: ${next}`);
      const close = valueOf('min-close');
      if (close) lines.push(`Prayer: ${close}`);
      const sign = valueOf('min-sign');
      if (sign) lines.push('', `Signed: ${sign}`);
      return lines.join('\n');
    }

    function storeRecord(record) {
      if (!currentAdmin || !canWriteRecordType(record.type)) {
        showToast('Your account role cannot save this type of record.', 'error');
        return false;
      }
      record.createdAt = record.createdAt || new Date().toISOString();
      record.version = Number(record.version) || 1;
      record._cloudSynced = false;
      const records = getRecords();
      records.unshift(record);
      if (!saveLocal(RECORDS_KEY, records)) return false;
      void queueRecordForCloud(record);
      if (record.type === 'Incident Report') refreshMessageCaseOptions();
      return true;
    }

    function saveLog() {
      const type = document.getElementById('log-type').value;
      let record;
      if (type === 'Incident Report') {
        const person = document.getElementById('inc-person').value.trim();
        const description = document.getElementById('inc-desc').value.trim();
        if (!person || !description) {
          showToast('Enter person(s) involved and factual description.', 'warning');
          return;
        }
        const status = document.getElementById('inc-status').value;
        const stage = document.getElementById('inc-stage').value;
        record = {
          id: `incident-${Date.now()}`,
          type,
          date: document.getElementById('inc-date').value || new Date().toLocaleString(),
          title: `${person} — ${document.getElementById('inc-dept').value}`,
          status,
          stage,
          assignee: document.getElementById('inc-assignee').value.trim(),
          dueDate: document.getElementById('inc-due').value,
          stageHistory: [{ at: new Date().toISOString(), stage, by: currentAdmin?.name || 'Secretariat' }],
          version: 1,
          outcome: '',
          details: `Location & Witnesses: ${document.getElementById('inc-witness').value.trim() || 'Not recorded'}\nFactual Description: ${description}\nImmediate Action: ${document.getElementById('inc-action').value.trim() || 'None recorded'}`
        };
        ['inc-person', 'inc-date', 'inc-witness', 'inc-desc', 'inc-action', 'inc-assignee', 'inc-due'].forEach(id => document.getElementById(id).value = '');
        document.getElementById('inc-status').value = 'Pending';
        document.getElementById('inc-stage').value = 'Open';
      } else {
        const agenda = getAgendaItems().filter(item => item.topic);
        if (!agenda.length) {
          showToast('Add at least one decision / action item.', 'warning');
          return;
        }
        record = {
          id: `minutes-${Date.now()}`,
          type,
          date: document.getElementById('min-date').value || localDateValue(),
          title: 'Committee Meeting Minutes',
          recorder: document.getElementById('min-recorded-by').value,
          details: buildMinutesDetails()
        };
        ['min-date', 'min-time', 'min-place', 'min-present', 'min-apology', 'min-opening',
          'min-last', 'min-next', 'min-close', 'min-sign', 'min-notes'].forEach(id => {
          const field = document.getElementById(id);
          if (field) field.value = '';
        });
        document.getElementById('min-recorded-by').selectedIndex = 0;
        clearAgendaItems();
      }
      if (storeRecord(record)) {
        showToast(`${type} saved offline.`, 'success');
        document.getElementById('log-type').value = 'Incident Report';
        setLogType('Incident Report');
      }
    }

    function updateMessagePreview() {
      const template = document.getElementById('message-template').value;
      const recipient = document.getElementById('msg-recipient').value.trim() || '[Recipient Name]';
      const department = document.getElementById('msg-department').value.trim() || '[Department]';
      const note = document.getElementById('msg-note').value.trim();
      document.getElementById('summons-fields').classList.toggle('hidden', template !== 'summons');
      const date = document.getElementById('msg-date').value || '[Date]';
      const time = document.getElementById('msg-time').value || '[Time]';
      const venue = document.getElementById('msg-venue').value.trim() || '[Venue]';
      let message;
      if (template === 'caution') {
        message = `Dear ${recipient},\n\nGreetings in Christ from the GEMYFELL @20 Secretariat. This is a respectful reminder regarding ${note || 'our worker and volunteer expectations'}${department ? ` in the ${department} team` : ''}. We appreciate your understanding and continued service. Please contact the Secretariat if you need to discuss this further.`;
      } else if (template === 'summons') {
        message = `Dear ${recipient},\n\nGreetings in Christ from the GEMYFELL @20 Secretariat. You are respectfully invited to attend a Disciplinary Committee hearing${department ? ` concerning ${department}` : ''}.\n\nDate: ${date}\nTime: ${time}\nVenue: ${venue}\n\n${note || 'Please attend to share any relevant information. The committee will hear the matter fairly, prayerfully, and respectfully.'}`;
      } else if (template === 'followup') {
        message = `Dear ${recipient},\n\nGreetings in Christ from the GEMYFELL @20 Secretariat. We are following up on the committee matter${department ? ` concerning the ${department} team` : ''}.\n\n${note || 'Please let us know the current status and any support you need.'}\n\nWe appreciate your cooperation and will close the matter respectfully once your response is received.`;
      } else if (template === 'ruling') {
        message = `Dear ${recipient},\n\nGreetings in Christ. The Disciplinary Committee has concluded its review${department ? ` of the matter concerning the ${department} team` : ''}.\n\n${note || 'The committee decision has been recorded and will be communicated to you separately.'}\n\nWe thank you for your honesty and cooperation throughout the process.`;
      } else if (template === 'general') {
        message = `Dear ${recipient},\n\nGreetings in Christ from the GEMYFELL @20 Secretariat${department ? ` and the ${department} team` : ''}.\n\n${note || 'This message is to keep you informed.'}\n\nPlease contact the Secretariat if you have any questions.`;
      } else {
        message = `Dear ${recipient},\n\nThe GEMYFELL @20 Secretariat and Disciplinary Committee sincerely thank you for your exemplary service${department ? ` with the ${department} team` : ''}. ${note || 'Your dedication, spiritual commitment, and positive example are greatly appreciated.'}\n\nThank you for faithfully serving our church community.`;
      }
      const caseId = document.getElementById('msg-case-id')?.value.trim() || '';
      document.getElementById('message-preview').textContent =
        `${message}${caseId ? `\n\nCase reference: ${caseId}` : ''}\n\nKind regards,\nSecretariat — GEMYFELL @20 Disciplinary Committee`;
    }

    function refreshMessageCaseOptions() {
      const select = document.getElementById('message-case');
      if (!select) return;
      const cases = getRecords().filter(record => record.type === 'Incident Report');
      const previous = select.value;
      select.innerHTML = '<option value="">Choose an incident report…</option>' + cases.map(record =>
        `<option value="${escapeHtml(record.id)}">${escapeHtml(`${record.date || ''} — ${record.title || ''}${record.status ? ` (${record.status})` : ''}`)}</option>`
      ).join('');
      if (cases.some(record => String(record.id) === previous)) select.value = previous;
    }

    function prefillMessageFromCase() {
      const id = document.getElementById('message-case')?.value;
      if (!id) {
        showToast('Choose a saved case first.', 'warning');
        return;
      }
      const record = getRecords().find(item => String(item.id) === String(id));
      if (!record) {
        showToast('That case is no longer on this device.', 'error');
        return;
      }
      const parts = String(record.title || '').split('—').map(part => part.trim());
      document.getElementById('msg-recipient').value = parts[0] || '';
      document.getElementById('msg-department').value = parts[1] || '';
      document.getElementById('msg-case-id').value = record.id;
      document.getElementById('msg-note').value = [
        record.details,
        record.assignee ? `Assigned officer: ${record.assignee}` : '',
        record.dueDate ? `Due date: ${record.dueDate}` : ''
      ].filter(Boolean).join('\n');
      document.getElementById('msg-date').value = record.dueDate || '';
      document.getElementById('message-template').value =
        record.status === 'Resolved' || record.stage === 'Closed' ? 'ruling'
          : record.dueDate ? 'summons' : 'followup';
      updateMessagePreview();
      showToast('Case details added to the message.', 'success');
    }

    function getMessageHistory() {
      const history = safeRead(MESSAGE_HISTORY_KEY, []);
      return Array.isArray(history) ? history : [];
    }

    function saveMessageToHistory(template, recipient, text) {
      if (!text.trim()) return;
      const history = getMessageHistory();
      history.unshift({ at: new Date().toISOString(), template, recipient, text });
      if (saveLocal(MESSAGE_HISTORY_KEY, history.slice(0, 20))) renderMessageHistory();
    }

    function messageTemplateLabel(value) {
      const options = [...(document.getElementById('message-template')?.options || [])];
      return options.find(option => option.value === value)?.textContent || 'Official Message';
    }

    function renderMessageHistory() {
      const container = document.getElementById('message-history');
      if (!container) return;
      const history = getMessageHistory();
      if (!history.length) {
        container.innerHTML = '<p class="hint">No messages composed yet. Your last 20 messages will appear here.</p>';
        return;
      }
      container.innerHTML = history.map((entry, index) => `
        <div class="message-item">
          <strong>${escapeHtml(messageTemplateLabel(entry.template))} · ${escapeHtml(entry.recipient || 'No recipient')}</strong>
          <span>${escapeHtml(new Date(entry.at).toLocaleString())}</span>
          <pre>${escapeHtml(entry.text)}</pre>
          <div class="toolbar">
            <button class="button-small secondary" type="button" onclick="reuseMessage(${index})">Use again</button>
            <button class="button-small secondary" type="button" onclick="deleteMessage(${index})">Remove</button>
          </div>
        </div>`).join('');
    }

    function reuseMessage(index) {
      const entry = getMessageHistory()[index];
      if (!entry) return;
      if (entry.template) document.getElementById('message-template').value = entry.template;
      if (entry.recipient) document.getElementById('msg-recipient').value = entry.recipient;
      document.getElementById('msg-note').value = entry.text
        .replace(/\n\n(Case reference:[^\n]*\n\n)?Kind regards,\nSecretariat — GEMYFELL @20 Disciplinary Committee$/, '');
      updateMessagePreview();
      document.getElementById('message-preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      showToast('Message loaded into the composer.', 'success');
    }

    function deleteMessage(index) {
      const history = getMessageHistory();
      if (!history[index]) return;
      history.splice(index, 1);
      if (saveLocal(MESSAGE_HISTORY_KEY, history)) renderMessageHistory();
    }

    function clearMessageHistory() {
      if (!confirm('Clear all saved message history on this device?')) return;
      if (saveLocal(MESSAGE_HISTORY_KEY, [])) {
        renderMessageHistory();
        showToast('Message history cleared.', 'success');
      }
    }

    function sendMessage() {
      const text = document.getElementById('message-preview').textContent;
      saveMessageToHistory(document.getElementById('message-template').value,
        document.getElementById('msg-recipient').value.trim(), text);
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    }

    async function copyMessage() {
      const text = document.getElementById('message-preview').textContent;
      saveMessageToHistory(document.getElementById('message-template').value,
        document.getElementById('msg-recipient').value.trim(), text);
      try {
        await navigator.clipboard.writeText(text);
        showToast('Official message copied to clipboard.', 'success');
      } catch (error) {
        const field = document.createElement('textarea');
        field.value = text;
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (copied) showToast('Official message copied to clipboard.', 'success');
        else showToast('Copy failed. Select and copy preview text manually.', 'error');
      }
    }

    function filterLogsSearch(query) {
      logsSearchTerm = (query || '').toLowerCase().trim();
      renderRecords();
    }

    function onDateRangeChange() {
      logsDateFrom = document.getElementById('logs-date-from')?.value || '';
      logsDateTo = document.getElementById('logs-date-to')?.value || '';
      renderRecords();
    }

    function clearDateRange() {
      logsDateFrom = '';
      logsDateTo = '';
      const from = document.getElementById('logs-date-from');
      const to = document.getElementById('logs-date-to');
      if (from) from.value = '';
      if (to) to.value = '';
      renderRecords();
    }

    function filteredRecords() {
      return getRecords()
        .filter(record => canReadRecordType(record.type))
        .filter(record => recordMatches(record, activeFilter, logsSearchTerm));
    }

    function recordMatches(record, filter, search) {
      // Filter tab check
      let matchesFilter = true;
      if (filter === 'Minutes') matchesFilter = record.type === 'Meeting Minutes';
      else if (filter === 'Attendance') matchesFilter = record.type === 'Attendance';
      else if (filter === 'Pending Cases') matchesFilter = record.type === 'Incident Report' && record.status !== 'Resolved';
      else if (filter === 'Resolved Cases') matchesFilter = record.type === 'Incident Report' && record.status === 'Resolved';

      if (!matchesFilter) return false;

      const date = String(record.date || '');
      if (logsDateFrom && date < logsDateFrom) return false;
      if (logsDateTo && date > logsDateTo) return false;
      if (!search) return true;

      // Search term check
      const text = `${record.type} ${record.title} ${record.details} ${record.status || ''} ${record.outcome || ''} ${record.recorder || ''} ${record.stage || ''} ${record.assignee || ''} ${record.dueDate || ''} ${date}`.toLowerCase();
      return text.includes(search);
    }

    function statusClass(status) {
      if (status === 'Resolved') return 'status-resolved';
      if (status === 'Hearing Scheduled') return 'status-hearing';
      return 'status-pending';
    }

    function renderDashboard() {
      const stats = document.getElementById('dashboard-stats');
      const recentBox = document.getElementById('dashboard-recent');
      if (!stats || !recentBox) return;

      const records = getRecords().filter(record => canReadRecordType(record.type));
      const incidents = records.filter(record => record.type === 'Incident Report');
      const pending = incidents.filter(record => record.status !== 'Resolved').length;
      const attendance = records
        .filter(record => record.type === 'Attendance')
        .sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')))[0];
      const counts = attendance ? attendanceCounts(attendance.statuses || {}) : {};
      const total = STATUSES.reduce((sum, status) => sum + (Number(counts[status]) || 0), 0);
      const attended = (Number(counts.Present) || 0) + (Number(counts.Late) || 0);
      const rate = total ? `${Math.round(attended / total * 100)}%` : '—';

      const cards = [
        { label: 'Pending Cases', value: pending, note: 'Incident reports open', tone: 'pending' },
        { label: 'Resolved Cases', value: incidents.length - pending, note: 'With committee ruling', tone: 'present' },
        { label: 'Meeting Minutes', value: records.filter(record => record.type === 'Meeting Minutes').length, note: 'Saved sittings', tone: 'excused' },
        { label: 'Attendance Rate', value: rate, note: attendance ? `On ${attendance.date}` : 'No roll call yet', tone: 'late' }
      ];
      stats.innerHTML = cards.map(card => `
        <div class="summary-count ${card.tone}">
          <strong>${escapeHtml(card.value)}</strong>
          ${escapeHtml(card.label)}
          <small>${escapeHtml(card.note)}</small>
        </div>`).join('');

      const recent = [...records].sort((left, right) => {
        const byCreated = Date.parse(right.createdAt || '') - Date.parse(left.createdAt || '');
        return Number.isNaN(byCreated) ? String(right.date || '').localeCompare(String(left.date || '')) : byCreated;
      }).slice(0, 5);
      if (!recent.length) {
        recentBox.innerHTML = '<p class="hint">No records saved yet. Log an incident or take roll call to get started.</p>';
        return;
      }
      recentBox.innerHTML = recent.map(record => {
        const tone = record.type === 'Incident Report'
          ? (record.status === 'Resolved' ? 'resolved' : '')
          : record.type === 'Attendance' ? 'attendance' : 'minutes';
        return `
          <div class="activity-item">
            <span class="activity-dot ${tone}"></span>
            <div class="activity-copy">
              <strong>${escapeHtml(record.title || record.type)}</strong>
              <span>${escapeHtml(record.type)} · ${escapeHtml(record.date)} · ${escapeHtml(record.status || 'Saved')}</span>
            </div>
          </div>`;
      }).join('');
    }

    function renderRecords() {
      const list = document.getElementById('records-list');
      const records = filteredRecords();
      
      if (!records.length) {
        list.innerHTML = `
          <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <p>${logsSearchTerm ? `No records found matching "${escapeHtml(logsSearchTerm)}".` : 'No saved records found for this category.'}</p>
          </div>`;
        return;
      }

      list.innerHTML = records.map(record => {
        const canWrite = canWriteRecordType(record.type);
        let borderAccent = 'var(--accent)';
        if (record.type === 'Meeting Minutes') borderAccent = '#64748b';
        else if (record.type === 'Attendance') borderAccent = '#0284c7';
        else if (record.status === 'Resolved') borderAccent = '#15803d';
        else if (record.status === 'Hearing Scheduled') borderAccent = '#1d4ed8';

        return `
        <article class="record-item" style="border-left-color: ${borderAccent};">
          <div class="record-header">
            <strong>${escapeHtml(record.type)}</strong>
            ${record.type === 'Incident Report' ? `<span class="status-badge ${statusClass(record.status)}">${escapeHtml(record.status || 'Pending')}</span>` : ''}
          </div>
          <div class="record-meta">${escapeHtml(record.date)} · ${escapeHtml(record.title)}</div>
          ${record.type === 'Incident Report' ? `
            <div class="case-meta">
              ${record.stage ? `<span class="stage-badge ${escapeHtml(record.stage)}">${escapeHtml(record.stage)}</span>` : ''}
              ${record.assignee ? `<span>👤 ${escapeHtml(record.assignee)}</span>` : ''}
              ${record.dueDate ? `<span>📅 Due ${escapeHtml(record.dueDate)}</span>` : ''}
              <span>Version ${escapeHtml(record.version || 1)}</span>
            </div>` : ''}
          ${record.type === 'Attendance' ? `
            <div class="summary-grid">
              ${STATUSES.map(status => `
                <div class="summary-count ${status.toLowerCase()}">
                  <strong>${attendanceCounts(record.statuses || {})[status] || 0}</strong>
                  ${status}
                </div>`).join('')}
            </div>` : ''}
          <pre>${escapeHtml(record.details || '')}${record.outcome ? `\n\nCommittee Outcome:\n${escapeHtml(record.outcome)}` : ''}</pre>
          ${record.type === 'Incident Report' && Array.isArray(record.stageHistory) && record.stageHistory.length ? `
            <div class="stage-history">Stages: ${record.stageHistory.map(item => `${escapeHtml(item.stage)} (${escapeHtml(new Date(item.at).toLocaleDateString())})`).join(' → ')}</div>` : ''}
          <div class="toolbar">
            ${canWrite && record.type === 'Incident Report' ? `<button class="secondary" data-action="advance" data-id="${escapeHtml(record.id)}">Advance Stage</button>` : ''}
            ${canWrite && record.type === 'Incident Report' ? `<button class="gold" data-action="resolve" data-id="${escapeHtml(record.id)}">${record.status === 'Resolved' ? 'Update Outcome' : 'Mark Resolved / Add Ruling'}</button>` : ''}
            <button class="whatsapp" data-action="share" data-id="${escapeHtml(record.id)}">Share via WhatsApp</button>
            ${canWrite ? `<button class="danger button-small" data-action="delete" data-id="${escapeHtml(record.id)}">Delete</button>` : ''}
          </div>
        </article>`;
      }).join('');

      list.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
        const record = getRecords().find(item => String(item.id) === button.dataset.id);
        if (!record) return;
        if (button.dataset.action === 'advance') advanceCaseStage(record.id);
        if (button.dataset.action === 'resolve') resolveCase(record.id);
        if (button.dataset.action === 'share') shareRecord(record);
        if (button.dataset.action === 'delete') deleteRecord(record.id);
      }));
      refreshMessageCaseOptions();
      renderDashboard();
    }

    function advanceCaseStage(id) {
      const records = getRecords();
      const index = records.findIndex(item => String(item.id) === String(id));
      if (index < 0) return;
      const record = records[index];
      if (!canWriteRecordType(record.type)) {
        showToast('Your account role cannot change this case.', 'error');
        return;
      }
      const stages = ['Open', 'Hearing', 'Ruling', 'Closed'];
      const current = stages.indexOf(record.stage || 'Open');
      if (current >= stages.length - 1) {
        showToast('This case is already closed.', 'info');
        return;
      }
      const next = stages[current + 1];
      if (!confirm(`Move this case from ${record.stage || 'Open'} to ${next}?`)) return;
      const history = Array.isArray(record.stageHistory) ? [...record.stageHistory] : [];
      history.push({ at: new Date().toISOString(), stage: next, by: currentAdmin?.name || 'Secretariat' });
      records[index] = {
        ...record,
        stage: next,
        status: next === 'Hearing' ? 'Hearing Scheduled' : next === 'Closed' ? 'Resolved' : record.status,
        stageHistory: history,
        _cloudSynced: false,
        createdAt: record.createdAt || new Date().toISOString()
      };
      if (saveLocal(RECORDS_KEY, records)) {
        void queueRecordForCloud(records[index]);
        showToast(`Case moved to ${next}.`, 'success');
        renderRecords();
      }
    }

    function resolveCase(id) {
      const record = getRecords().find(item => String(item.id) === String(id));
      if (!record) return;
      if (!canWriteRecordType(record.type)) {
        showToast('Your account role cannot resolve this case.', 'error');
        return;
      }
      const outcome = prompt('Enter the committee’s final ruling or resolution outcome:', '');
      if (outcome === null || !outcome.trim()) return;
      const records = getRecords();
      const index = records.findIndex(item => String(item.id) === String(id));
      const previousOutcome = records[index].outcome || '';
      const history = Array.isArray(records[index].stageHistory) ? [...records[index].stageHistory] : [];
      history.push({ at: new Date().toISOString(), stage: 'Closed', by: currentAdmin?.name || 'Secretariat' });
      records[index] = {
        ...records[index],
        status: 'Resolved',
        stage: 'Closed',
        stageHistory: history,
        outcome: [previousOutcome, `${new Date().toLocaleString()}: ${outcome.trim()}`].filter(Boolean).join('\n'),
        _cloudSynced: false,
        createdAt: records[index].createdAt || new Date().toISOString()
      };
      if (saveLocal(RECORDS_KEY, records)) {
        void queueRecordForCloud(records[index]);
        showToast('Case resolved and committee outcome recorded.', 'success');
        renderRecords();
      }
    }

    function shareRecord(record) {
      const text = record.type === 'Attendance'
        ? attendanceMessage(record)
        : `*GEMYFELL @20 ANNIVERSARY — OFFICIAL SECRETARIAT*\n*${record.type}*\n*Date:* ${record.date}\n*Subject:* ${record.title}${record.status ? `\n*Case Status:* ${record.status}` : ''}${record.stage ? `\n*Stage:* ${record.stage}` : ''}${record.assignee ? `\n*Assigned:* ${record.assignee}` : ''}${record.dueDate ? `\n*Due:* ${record.dueDate}` : ''}\n\n${record.details}${record.outcome ? `\n\n*Committee Outcome:* ${record.outcome}` : ''}`;
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    }

    function deleteRecord(id) {
      const recordId = String(id);
      const record = getRecords().find(item => String(item.id) === recordId);
      if (!record || !canWriteRecordType(record.type)) {
        showToast('Your account role cannot delete this record.', 'error');
        return;
      }
      if (!confirm('Are you sure you want to delete this official record? This cannot be undone.')) return;
      const previousDeletes = getPendingCloudDeletes();
      if (!saveLocal(DELETED_RECORDS_KEY, [...new Set([...previousDeletes, recordId])])) return;
      const remainingRecords = getRecords().filter(record => String(record.id) !== recordId);
      if (!saveLocal(RECORDS_KEY, remainingRecords)) {
        saveLocal(DELETED_RECORDS_KEY, previousDeletes);
        return;
      }
      void enqueueCloudOperation(async () => {
        try {
          updateCloudStatus('syncing');
          await deleteCloudRecordDirect(recordId);
          updateCloudStatusFromLocal();
        } catch (error) {
          console.warn('Record deletion remains queued on this device:', error);
          updateCloudStatus(cloudErrorStatus(error));
        }
      });
      showToast('Record deleted.', 'info');
      renderRecords();
    }

    function csvCell(value) {
      const text = String(value ?? '');
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }

    function exportRecordsCsv() {
      const records = filteredRecords();
      if (!records.length) {
        showToast('No records match the current filters.', 'warning');
        return;
      }
      const header = ['ID', 'Type', 'Date', 'Title', 'Status', 'Stage', 'Assignee', 'Due Date', 'Recorder', 'Details', 'Outcome', 'Version', 'Created At'];
      const rows = records.map(record => [
        record.id,
        record.type,
        record.date,
        record.title,
        record.status,
        record.stage,
        record.assignee,
        record.dueDate,
        record.recorder,
        record.details,
        record.outcome,
        record.version,
        record.createdAt || record.created_at
      ]);
      const csv = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
      const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `gemyfell-records-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`${records.length} record(s) exported to CSV.`, 'success');
    }

    function exportRecords() {
      const records = getRecords().filter(record => canReadRecordType(record.type));
      if (!records.length) {
        showToast('No records to export yet.', 'warning');
        return;
      }
      const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `gemyfell-secretariat-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Backup file exported successfully.', 'success');
    }

    function importRecords(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        showToast('Backup file is too large (maximum 5 MB).', 'error');
        event.target.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const incoming = JSON.parse(reader.result);
          if (!Array.isArray(incoming)) {
            throw new Error('Backup must be an array of valid saved records.');
          }
          const seen = new Set();
          const sanitized = incoming.map(record => {
            if (!record || !record.id || !ALLOWED_RECORD_TYPES.has(record.type) ||
                !record.date || !record.title || typeof record.details !== 'string') {
              throw new Error('Backup must be an array of valid saved records.');
            }
            const id = String(record.id);
            if (seen.has(id)) throw new Error('Backup contains duplicate record IDs.');
            seen.add(id);
            const createdAt = typeof record.createdAt === 'string' && !Number.isNaN(Date.parse(record.createdAt))
              ? record.createdAt
              : new Date().toISOString();
            const clean = {
              id,
              type: record.type,
              date: String(record.date),
              title: String(record.title),
              status: record.status == null ? '' : String(record.status),
              recorder: record.recorder == null ? '' : String(record.recorder),
              details: String(record.details),
              version: Number(record.version) || 1,
              assignee: record.assignee == null ? '' : String(record.assignee),
              dueDate: record.dueDate == null ? '' : String(record.dueDate),
              stage: record.stage == null ? '' : String(record.stage),
              stageHistory: Array.isArray(record.stageHistory) ? record.stageHistory : [],
              createdAt,
              _cloudSynced: false
            };
            if (record.type === 'Incident Report') {
              clean.outcome = record.outcome == null ? '' : String(record.outcome);
            }
            if (record.type === 'Attendance') {
              clean.statuses = record.statuses && typeof record.statuses === 'object' ? record.statuses : {};
            }
            return clean;
          });
          const existing = getRecords();
          const ids = new Set(existing.map(record => String(record.id)));
          const additions = sanitized.filter(record => !ids.has(record.id));
          if (saveLocal(RECORDS_KEY, [...additions, ...existing])) {
            renderRecords();
            showToast(`${additions.length} new record(s) imported. Existing kept.`, 'success');
          }
        } catch (error) {
          showToast(`Import failed: ${error.message}`, 'error');
        } finally {
          event.target.value = '';
        }
      };
      reader.onerror = () => showToast('Could not read the selected backup file.', 'error');
      reader.readAsText(file);
    }

    function printLogs() {
      document.getElementById('print-date').textContent = `Generated ${new Date().toLocaleString()}`;
      window.print();
    }

    // Event Listeners & Initialization
    document.getElementById('admin-login-form').addEventListener('submit', event => {
      event.preventDefault();
      void loginAdmin();
    });
    document.getElementById('pin-setup-form').addEventListener('submit', event => {
      event.preventDefault();
      void completePinSetup();
    });
    document.getElementById('create-admin-form').addEventListener('submit', event => { void createAdministrator(event); });
    document.getElementById('log-filters').addEventListener('click', event => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      activeFilter = button.dataset.filter;
      document.querySelectorAll('.filter-pill').forEach(pill => pill.classList.toggle('selected', pill === button));
      renderRecords();
    });

    ['message-template', 'msg-recipient', 'msg-department', 'msg-note', 'msg-date', 'msg-time', 'msg-venue'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', updateMessagePreview);
        el.addEventListener('change', updateMessagePreview);
      }
    });
    document.getElementById('message-case')?.addEventListener('change', () => {
      document.getElementById('msg-case-id').value = '';
      updateMessagePreview();
    });

    document.getElementById('roll-date').value = localDateValue();
    const assigneeOptions = document.getElementById('committee-options');
    if (assigneeOptions) {
      assigneeOptions.innerHTML = [...new Set(TEAM_GROUPS.flatMap(group => group.people.map(person => person.name)))]
        .map(name => `<option value="${escapeHtml(name)}"></option>`).join('');
    }
    addAgendaItem();
    renderDirectory();
    renderDashboard();
    onRollDateChange();
    refreshMessageCaseOptions();
    renderMessageHistory();
    updateMessagePreview();
    updateCloudStatus(!navigator.onLine ? 'offline' : 'authRequired');
    window.addEventListener('online', () => {
      if (readAuthSession()) {
        void syncCloudRecords();
        void syncCommitteePhones();
        void syncSharedRollCalls();
      } else updateCloudStatus('authRequired');
    });
    window.addEventListener('offline', () => updateCloudStatus('offline'));

    void initializeAdminSession();

    function dismissSplash() {
      const splash = document.getElementById('pwa-splash');
      if (!splash || splash.classList.contains('fade-out')) return;
      splash.classList.add('fade-out');
      setTimeout(() => { if (splash.parentElement) splash.remove(); }, 420);
    }

    if (sessionStorage.getItem('gemyfell_splash_seen') === 'true') {
      const splash = document.getElementById('pwa-splash');
      if (splash) splash.remove();
    } else {
      sessionStorage.setItem('gemyfell_splash_seen', 'true');
      setTimeout(dismissSplash, 1100);
    }

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(error => console.error('Service worker registration failed:', error));
      });
    }
  