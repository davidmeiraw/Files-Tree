// app.js - Arbol de carpetas interactivo
(() => {
  // Utilities
  const $ = id => document.getElementById(id);
  const qs = (el, sel) => el.querySelector(sel);
  const clone = v => JSON.parse(JSON.stringify(v));
  const uid = () => 'n_' + Math.random().toString(36).slice(2,9);

  // parse tags separated by commas, remove empties and duplicates
  function parseTags(input){
    if (!input) return [];
    return Array.from(new Set(String(input).split(/\s*,\s*/).map(s=>s.trim()).filter(Boolean)));
  }

  // DOM
  const treeContainer = $('treeContainer');
  const nameInput = $('nameInput');
  const descInput = $('descInput');
  const tagsInput = $('tagsInput');
  const addChildBtn = $('addChildBtn');
  const deleteBtn = $('deleteBtn');
  const addRootBtn = $('addRootBtn');
  const tagFilter = $('tagFilter');
  const exportPdfBtn = $('exportPdfBtn');
  const exportJsonBtn = $('exportJsonBtn');
  const importJsonBtn = $('importJsonBtn');
  const importJsonInput = $('importJsonInput');
  const syncGithubBtn = $('syncGithubBtn');
  const pushBtn = $('pushBtn');
  const pullBtn = $('pullBtn');
  const autoSync = $('autoSync');
  const ghToken = $('ghToken');
  const ghOwner = $('ghOwner');
  const ghRepo = $('ghRepo');
  const ghPath = $('ghPath');
  const syncStatus = $('syncStatus');
  // login DOM
  const loginModal = $('loginModal');
  const loginUser = $('loginUser');
  const loginPass = $('loginPass');
  const loginBtn = $('loginBtn');

  // Data model: array of nodes
  // node = { id, parentId (null=root), name, description, tags:[], children: [] }
  let nodes = [];
  let selectedId = null;
  const STORAGE_KEY = 'folderTree_v1';
  const FILE_CACHE_KEY = 'dataTree_file_cache';
  const DATA_URL = 'data-tree.json';
  function syncActionState(){
    if (!deleteBtn) return;
    deleteBtn.disabled = !selectedId;
  }

  // Auth cookie name
  const AUTH_COOKIE = 'fs_user';
  const INACTIVITY_MS = 10 * 60 * 1000; // 10 minutes
  let inactivityTimer = null;

  // --- Persistence ---
  function saveLocal() {
    try {
      // persist locally for quick restore
      const serialized = JSON.stringify(nodes);
      localStorage.setItem(STORAGE_KEY, serialized);
      localStorage.setItem(FILE_CACHE_KEY, serialized);
      showStatus('Guardado localmente');
      // schedule an auto-push if enabled
      try{ scheduleAutoPush(); }catch(e){}

      // Try to persist the canonical JSON to DATA_URL on the same origin if the server allows
      // If that fails, and GitHub credentials are configured, push via the GitHub API.
      (async () => {
        try {
          const res = await fetch(DATA_URL, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(nodes, null, 2)
          });
          if (res && res.ok) {
            showStatus('Guardado en ' + DATA_URL);
            return;
          }
        } catch (e) {
          // writing to same-origin file failed (common on static hosting)
        }

        // Fallback: if GitHub credentials present, push to the repo path
        try {
          if (ghToken && ghToken.value && ghToken.value.trim() && ghOwner && ghOwner.value && ghOwner.value.trim() && ghRepo && ghRepo.value && ghRepo.value.trim()) {
            await pushToGitHubAuto();
          }
        } catch (e) {}
      })();
    } catch (e) {
      console.error(e);
      showStatus('Error guardando localmente');
    }
  }
  function loadLocal() {
    // Attempt to load remote JSON (data-tree.json) first
    return fetch(DATA_URL, { cache: 'no-store' })
      .then(res => {
        if (!res.ok) throw new Error('No remote JSON');
        return res.json();
      })
      .then(j => { nodes = j || []; nodes.forEach(n => { if (typeof n.collapsed === 'undefined') n.collapsed = false; }); return true; })
      .catch(_ => {
        // fallback to cached file contents first
        const primary = localStorage.getItem(FILE_CACHE_KEY);
        const fallback = localStorage.getItem(STORAGE_KEY);
        const raw = primary || fallback;
        if (!raw) return false;
        try { nodes = JSON.parse(raw); nodes.forEach(n => { if (typeof n.collapsed === 'undefined') n.collapsed = false; }); return true; }
        catch (e) { console.warn(e); return false; }
      });
  }

  // --- Tree helpers ---
  function findNode(id) { return nodes.find(n => n.id === id); }
  function childrenOf(parentId){ return nodes.filter(n => n.parentId === parentId).sort((a,b)=> (a.name||'').localeCompare(b.name||'')); }
  function buildHierarchy() {
    // nodes array is flat; rendering uses parentId
    renderTree();
    populateTagsDropdown();
  }
  // Given a selected node id, climb to its root id
  function getSelectedRootId(){
    if (!selectedId) return null;
    let n = findNode(selectedId);
    while (n && n.parentId) n = findNode(n.parentId);
    return n ? n.id : null;
  }

  // --- Render ---
  function renderTree() {
    treeContainer.innerHTML = '';
    const roots = childrenOf(null);
    const list = document.createElement('ul');
    list.className = 'node-list';
    roots.forEach(r => list.appendChild(renderNodeItem(r)));
    treeContainer.appendChild(list);
  }

  function renderNodeItem(node, isLastChild = false) {
    const li = document.createElement('li');
    const wrapper = document.createElement('div');
    wrapper.className = 'tree-node';
    wrapper.draggable = true;
    wrapper.dataset.id = node.id;
    if (node.collapsed) wrapper.classList.add('collapsed');

    // Drag handlers
    wrapper.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', node.id);
      e.stopPropagation();
    });
    wrapper.addEventListener('dragover', e => {
      e.preventDefault();
    });
    wrapper.addEventListener('drop', e => {
      e.preventDefault();
      const srcId = e.dataTransfer.getData('text/plain');
      if (!srcId || srcId === node.id) return;
      moveNode(srcId, node.id);
    });

    // Expander control
    const expander = document.createElement('button');
    expander.type = 'button';
    expander.className = 'expander';
    expander.title = node.collapsed ? 'Expandir' : 'Colapsar';
    expander.setAttribute('aria-expanded', String(!node.collapsed));
    expander.innerHTML = '<span class="arrow">&#9656;</span>';
    expander.addEventListener('click', e => {
      e.stopPropagation();
      node.collapsed = !node.collapsed;
      saveLocal();
      renderTree();
      selectNode(node.id);
    });

    // Click select
    wrapper.addEventListener('click', e => {
      e.stopPropagation();
      selectNode(node.id);
    });

    // Double click toggles collapse/expand
    wrapper.addEventListener('dblclick', e => {
      e.stopPropagation();
      const childUl = wrapper.nextElementSibling;
      if (childUl && childUl.tagName === 'UL') {
        childUl.style.display = childUl.style.display === 'none' ? '' : 'none';
      }
    });

    const title = document.createElement('div');
    title.className = 'node-title';
    title.textContent = (node.name || '(sin nombre)');

    const meta = document.createElement('div');
    meta.className = 'node-meta';
    meta.textContent = node.tags && node.tags.length ? node.tags.join(', ') : '';

    // add expander when there are children
    const kids = childrenOf(node.id);
    if (kids.length) {
      wrapper.appendChild(expander);
      wrapper.classList.add('has-children');
    } else {
      const spacer = document.createElement('span'); spacer.className = 'expander spacer'; spacer.innerHTML = '';
      wrapper.appendChild(spacer);
    }

    wrapper.appendChild(title);

    // meta: tags (azul) then description (gris) on the right
    meta.innerHTML = '';
    // show tags inline on the right (blue badges) placed before description per request
    if (node.tags && node.tags.length) {
      const tagsWrap = document.createElement('span');
      tagsWrap.className = 'tags-wrap';
      node.tags.forEach(t => {
        const ts = document.createElement('span'); ts.className = 'tag inline'; ts.textContent = t;
        tagsWrap.appendChild(ts);
      });
      meta.appendChild(tagsWrap);
    }
    if (node.description) {
      const d = document.createElement('span');
      d.className = 'node-desc';
      d.textContent = node.description;
      meta.appendChild(d);
    }
    wrapper.appendChild(meta);

    if (selectedId === node.id) wrapper.classList.add('selected');

    li.appendChild(wrapper);

    // children
    if (kids.length) {
      const childList = document.createElement('ul');
      childList.className = 'node-list';
      kids.forEach(k => childList.appendChild(renderNodeItem(k)));
      // respect collapsed state
      childList.style.display = node.collapsed ? 'none' : '';
      li.appendChild(childList);
    }

    return li;
  }

  // --- Selection & editing ---
  function selectNode(id) {
    selectedId = id;
    // highlight
    Array.from(document.querySelectorAll('.tree-node')).forEach(el => {
      el.classList.toggle('selected', el.dataset.id === id);
    });
    const node = findNode(id);
    if (node) {
      nameInput.value = node.name || '';
      descInput.value = node.description || '';
      tagsInput.value = (node.tags || []).join(', ');
    } else {
      nameInput.value = descInput.value = tagsInput.value = '';
    }
    syncActionState();
  }

  // preserve focus & selection for inputs while running an update that re-renders
  function withPreservedInput(fn){
    const active = document.activeElement;
    let info = null;
    if (active && (active === nameInput || active === descInput || active === tagsInput)){
      info = { id: active.id, value: active.value, start: active.selectionStart, end: active.selectionEnd };
    }
    try{ fn(); }catch(e){ console.error(e); }
    if (info){
      const el = $(info.id);
      if (el){
        el.focus();
        // restore value (in case render/selection overwrote it)
        el.value = info.value;
        try{ if (typeof el.setSelectionRange === 'function') el.setSelectionRange(info.start, info.end); }catch(e){}
      }
    }
  }

  // --- CRUD operations ---
  function createNode({ parentId = null, name = 'Nueva carpeta', description = '', tags = [] } = {}) {
    const n = { id: uid(), parentId, name, description, tags: parseTags(tags.join ? tags.join(',') : (tags||'')), collapsed: false };
    nodes.push(n);
    saveLocal();
    withPreservedInput(()=>{ renderTree(); selectNode(n.id); });
    syncActionState();
  }

  function updateNode(id, updates) {
    const n = findNode(id);
    if (!n) return;
    Object.assign(n, updates);
    saveLocal();
    withPreservedInput(()=>{ renderTree(); selectNode(id); });
  }

  function deleteNode(id) {
    // remove node and descendants
    const current = findNode(id);
    if (!current) return;
    const fallbackParent = current.parentId;
    const toRemove = new Set();
    function walk(rid){ toRemove.add(rid); childrenOf(rid).forEach(c=>walk(c.id)); }
    walk(id);
    nodes = nodes.filter(n => !toRemove.has(n.id));
    selectedId = (selectedId && toRemove.has(selectedId)) ? null : selectedId;
    saveLocal();
    withPreservedInput(()=>{ 
      renderTree();
      // prefer parent, otherwise first root
      const nextSelection = fallbackParent || (childrenOf(null)[0] && childrenOf(null)[0].id) || null;
      if (selectedId) selectNode(selectedId);
      else if (nextSelection) selectNode(nextSelection);
      else {
        nameInput.value = descInput.value = tagsInput.value = '';
        syncActionState();
      }
    });
    syncActionState();
  }

  function moveNode(srcId, targetParentId) {
    const src = findNode(srcId);
    if (!src) return;
    // prevent moving into own descendant
    let p = targetParentId;
    while (p) { if (p === srcId) return; p = findNode(p) && findNode(p).parentId; }
    src.parentId = targetParentId;
    saveLocal();
    withPreservedInput(()=>{ renderTree(); selectNode(srcId); });
  }

  // --- Custom confirmation modal (no sandbox issues) ---
  function showConfirmModal(message) {
    return new Promise(resolve => {
      const modal = document.createElement('div');
      modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
      `;
      
      const dialog = document.createElement('div');
      dialog.style.cssText = `
        background: #11182e;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 12px;
        padding: 24px;
        max-width: 400px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.35);
      `;
      
      const text = document.createElement('p');
      text.style.cssText = 'color: #e7ecff; margin: 0 0 20px 0; font-size: 14px;';
      text.textContent = message;
      
      const buttons = document.createElement('div');
      buttons.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';
      
      const btnCancel = document.createElement('button');
      btnCancel.textContent = 'Cancelar';
      btnCancel.style.cssText = `
        padding: 10px 14px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.04);
        color: #e7ecff;
        cursor: pointer;
        font-weight: 600;
      `;
      btnCancel.onclick = () => { modal.remove(); resolve(false); };
      
      const btnConfirm = document.createElement('button');
      btnConfirm.textContent = 'Eliminar';
      btnConfirm.style.cssText = `
        padding: 10px 14px;
        border-radius: 8px;
        border: none;
        background: linear-gradient(135deg, #3fd0a6, #7cf2c9);
        color: #021310;
        cursor: pointer;
        font-weight: 600;
      `;
      btnConfirm.onclick = () => { modal.remove(); resolve(true); };
      
      buttons.appendChild(btnCancel);
      buttons.appendChild(btnConfirm);
      
      dialog.appendChild(text);
      dialog.appendChild(buttons);
      modal.appendChild(dialog);
      document.body.appendChild(modal);
    });
  }

  // --- Tags dropdown & filter ---
  function getAllTags() {
    const set = new Set();
    nodes.forEach(n => (n.tags||[]).forEach(t => set.add(t)));
    return Array.from(set).sort();
  }
  function populateTagsDropdown() {
    const tags = getAllTags();
    tagFilter.innerHTML = '<option value="">-- Filtrar por etiqueta --</option>';
    tags.forEach(t => {
      const o = document.createElement('option'); o.value = t; o.textContent = t;
      tagFilter.appendChild(o);
    });
  }
  // helper: check whether node or any descendant has tag
  function nodeOrDescendantHasTag(node, tag) {
    if (!node) return false;
    if ((node.tags || []).includes(tag)) return true;
    const kids = childrenOf(node.id);
    for (let k of kids) if (nodeOrDescendantHasTag(k, tag)) return true;
    return false;
  }

  tagFilter.addEventListener('change', () => {
    const val = tagFilter.value;
    if (!val) {
      // when clearing the filter, just re-render (keeps existing collapsed states)
      renderTree();
      // clear highlights / opacity
      Array.from(document.querySelectorAll('.tree-node')).forEach(el => { el.classList.remove('match'); el.style.opacity = ''; });
      return;
    }
    // For each node, set collapsed=false for branches that contain the tag, collapse others
    nodes.forEach(n => {
      const has = nodeOrDescendantHasTag(n, val);
      n.collapsed = !has;
    });
    saveLocal();
    renderTree();
    // highlight matching nodes and dim others
    let firstMatchEl = null;
    Array.from(document.querySelectorAll('.tree-node')).forEach(el => {
      const id = el.dataset.id;
      const node = findNode(id);
      if (!node) return;
      if ((node.tags||[]).includes(val)) {
        el.classList.add('match');
        el.style.opacity = '1';
        if (!firstMatchEl) firstMatchEl = el;
      } else {
        el.classList.remove('match');
        el.style.opacity = '0.45';
      }
    });
    if (firstMatchEl) firstMatchEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  // --- Auto-push to GitHub ---
  let autoPushTimer = null;
  function scheduleAutoPush(){
    try{
      if (!autoSync || !autoSync.checked) return;
      clearTimeout(autoPushTimer);
      autoPushTimer = setTimeout(()=>{ pushToGitHubAuto(); }, 1200);
    }catch(e){ }
  }

  async function pushToGitHubAuto(){
    const token = ghToken.value.trim();
    const owner = ghOwner.value.trim();
    const repo = ghRepo.value.trim();
    const path = ghPath.value.trim();
    if (!token || !owner || !repo || !path) { showStatus('Auto-sync no configurado'); return; }
    showStatus('Auto-sync: enviando a GitHub...');
    try {
      await githubPutFile(token, owner, repo, path, JSON.stringify(nodes, null, 2), 'Auto-sync: actualiza arbol');
      showStatus('Auto-sync: push OK');
    } catch (err) {
      console.error(err);
      showStatus('Auto-sync error');
    }
  }

  // wire push button to cancel any pending autoPush and execute immediately
  pushBtn.addEventListener('click', () => { clearTimeout(autoPushTimer); });

  // --- Export / Import JSON ---
  function exportJSON() {
    const data = JSON.stringify(nodes, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'data-tree.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  importJsonBtn.addEventListener('click', () => importJsonInput.click());
  importJsonInput.addEventListener('change', ev => {
    const f = ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (Array.isArray(parsed)) {
          nodes = parsed;
          nodes.forEach(n => { if (typeof n.collapsed === 'undefined') n.collapsed = false; });
          saveLocal();
          renderTree();
          showStatus('Importado JSON correctamente');
        } else showStatus('JSON invalido');
      } catch (err) { showStatus('Error leyendo JSON'); }
    };
    reader.readAsText(f);
    ev.target.value = '';
  });

  // --- PDF export ---
  exportPdfBtn.addEventListener('click', async () => {
    showStatus('Generando PDF...');
    const { jsPDF } = window.jspdf;
    
    try {
      const pdf = new jsPDF({ 
        orientation: 'portrait', 
        unit: 'mm', 
        format: 'a4',
        compress: true
      });
      
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      let yPos = 15;
      const lineHeight = 8;
      const leftMargin = 15;
      const indentPerLevel = 8;
      
      // Title
      pdf.setFontSize(18);
      pdf.setTextColor(63, 208, 166); // accent color
      pdf.text('Files Documentation', pageWidth / 2, yPos, { align: 'center' });
      yPos += 12;
      
      // Date
      pdf.setFontSize(10);
      pdf.setTextColor(100, 100, 100);
      const now = new Date().toLocaleDateString('es-ES');
      pdf.text(`Generado: ${now}`, pageWidth / 2, yPos-5, { align: 'center' });
      yPos += 10;
      
      // Draw tree
      pdf.setFontSize(12);
      pdf.setTextColor(30, 30, 30); // dark text
      
      function renderNodeToPDF(node, level) {
        // Check if we need a new page
        if (yPos > pageHeight - 20) {
          pdf.addPage();
          yPos = 15;
        }
        
        const indent = leftMargin + (level * indentPerLevel);
        
        // Draw hierarchy lines (visual connectors)
        if (level > 0) {
          pdf.setDrawColor(180, 180, 180);
          pdf.setLineWidth(0.3);
          // Vertical line connection
          pdf.line(indent - 5, yPos - 2, indent - 5, yPos + 3);
          // Horizontal line branch
          pdf.line(indent - 5, yPos, indent - 2, yPos);
        }
        
        // Node name with bracket symbol (bold) - ASCII only for jsPDF compatibility
        pdf.setFont(undefined, 'bold');
        pdf.setFontSize(12);
        pdf.setTextColor(30, 30, 30);
        const nameText = '[+] ' + (node.name || '(sin nombre)');
        pdf.text(nameText, indent, yPos);
        
        // Calculate space used by name
        const nameWidth = pdf.getStringUnitWidth(nameText) * 12 / pdf.internal.scaleFactor;
        let currentX = indent + nameWidth + 2; // 2mm de separacion
        
        // Check if we have space for tags on same line
        let tagsOnSameLine = false;
        
        if (node.tags && node.tags.length) {
          pdf.setFont(undefined, 'normal');
          pdf.setFontSize(8);
          pdf.setTextColor(100, 150, 200); // blue color for tags
          const tagsStr = node.tags.join(', ');
          const tagsWidth = pdf.getStringUnitWidth(tagsStr) * 8 / pdf.internal.scaleFactor;
          
          // Check if tags fit on same line (leave 15mm margin)
          if (currentX + tagsWidth + 15 < pageWidth - 15) {
            pdf.text('[' + tagsStr + ']', currentX, yPos);
            tagsOnSameLine = true;
            currentX = currentX + tagsWidth + 3; // gap after tags
          }
        }
        
        // Description handling
        if (node.description) {
          pdf.setFont(undefined, 'normal');
          pdf.setFontSize(9);
          pdf.setTextColor(100, 100, 100);
          
          if (tagsOnSameLine) {
            // Try to fit description on same line after tags
            const descMaxWidth = pageWidth - currentX - 15;
            const descLines = pdf.splitTextToSize(node.description, descMaxWidth);
            
            if (descLines.length === 1 && descMaxWidth > 40) {
              pdf.text('- ' + descLines[0], currentX, yPos);
            } else {
              // Description on next line
              yPos += lineHeight;
              const fullDescWidth = pageWidth - leftMargin - indentPerLevel - 15;
              const fullDescLines = pdf.splitTextToSize(node.description, fullDescWidth);
              fullDescLines.forEach(line => {
                if (yPos > pageHeight - 20) {
                  pdf.addPage();
                  yPos = 15;
                }
                pdf.text('  ' + line, indent + 3, yPos);
                yPos += lineHeight * 0.85;
              });
            }
          } else {
            // Description on next line when tags don't fit
            yPos += lineHeight;
            const fullDescWidth = pageWidth - leftMargin - indentPerLevel - 15;
            const fullDescLines = pdf.splitTextToSize(node.description, fullDescWidth);
            fullDescLines.forEach(line => {
              if (yPos > pageHeight - 20) {
                pdf.addPage();
                yPos = 15;
              }
              pdf.text('  ' + line, indent + 3, yPos);
              yPos += lineHeight * 0.85;
            });
          }
        }
        
        // Ensure proper spacing after node
        yPos += lineHeight * 0.5;
        
        // Render children with hierarchy indicators
        const kids = childrenOf(node.id);
        kids.forEach((child, idx) => {
          renderNodeToPDF(child, level + 1);
        });
      }
      
      // Render all root nodes
      const roots = childrenOf(null);
      roots.forEach(root => {
        renderNodeToPDF(root, 0);
      });
      
      pdf.save('folder-tree.pdf');
      showStatus('PDF generado correctamente');
    } catch (err) {
      console.error(err);
      showStatus('Error generando PDF');
    }
  });

  // --- GitHub push/pull (simple implementation, requires PAT with repo scope) ---
  async function githubPutFile(token, owner, repo, path, contentStr, message = 'Update folder-tree.json') {
    const api = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
    // check existing file to get sha
    const headers = { Authorization: 'token ' + token, Accept: 'application/vnd.github.v3+json' };
    let sha = null;
    try {
      const getRes = await fetch(api, { headers });
      if (getRes.ok) {
        const j = await getRes.json();
        sha = j.sha;
      }
    } catch (e) {
      // ignore; may not exist
    }
    const body = {
      message,
      content: btoa(unescape(encodeURIComponent(contentStr))),
      sha: sha || undefined
    };
    const putRes = await fetch(api, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) });
    if (!putRes.ok) {
      const txt = await putRes.text();
      throw new Error('GitHub error: ' + putRes.status + ' - ' + txt);
    }
    return putRes.json();
  }

  async function githubGetFile(token, owner, repo, path) {
    const api = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
    const headers = { Authorization: 'token ' + token, Accept: 'application/vnd.github.v3+json' };
    const res = await fetch(api, { headers });
    if (!res.ok) throw new Error('No se pudo obtener: ' + res.status);
    const j = await res.json();
    const content = decodeURIComponent(escape(atob(j.content)));
    return content;
  }

  pushBtn.addEventListener('click', async () => {
    const token = ghToken.value.trim();
    const owner = ghOwner.value.trim();
    const repo = ghRepo.value.trim();
    const path = ghPathOrDefault();
    if (!token || !owner || !repo || !path) { showStatus('Rellena token/owner/repo/path'); return; }
    showStatus('Enviando a GitHub...');
    try {
      const res = await githubPutFile(token, owner, repo, path, JSON.stringify(nodes, null, 2), 'Actualiza arbol de carpetas');
      showStatus('Push OK: ' + (res.content && res.content.path));
    } catch (err) {
      console.error(err);
      showStatus('Error en push: ' + (err.message||err));
    }
  });

  pullBtn.addEventListener('click', async () => {
    const token = ghToken.value.trim();
    const owner = ghOwner.value.trim();
    const repo = ghRepo.value.trim();
    const path = ghPathOrDefault();
    if (!token || !owner || !repo || !path) { showStatus('Rellena token/owner/repo/path'); return; }
    showStatus('Descargando desde GitHub...');
    try {
      const content = await githubGetFile(token, owner, repo, path);
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        nodes = parsed;
        nodes.forEach(n => { if (typeof n.collapsed === 'undefined') n.collapsed = false; });
        saveLocal();
        renderTree();
        showStatus('Importado desde GitHub correctamente');
      } else showStatus('Contenido GitHub invalido');
    } catch (err) {
      console.error(err);
      showStatus('Error en pull: ' + (err.message||err));
    }
  });

  // --- UI events ---
  addChildBtn.addEventListener('click', () => {
    const parentId = selectedId || null;
    createNode({ parentId, name: 'Nueva carpeta' });
  });

  // Fallback: ensure clicking anywhere inside a tree-node selects it
  treeContainer.addEventListener('click', e => {
    const el = e.target.closest('.tree-node');
    if (el && el.dataset.id) {
      selectNode(el.dataset.id);
    }
  });

  deleteBtn.addEventListener('click', async () => {
    if (!selectedId) { showStatus('Selecciona una carpeta'); return; }
    const nodeToDelete = findNode(selectedId);
    if (!nodeToDelete) { showStatus('Nodo no encontrado'); return; }
    const confirmed = await showConfirmModal(`Eliminar "${nodeToDelete.name || 'sin nombre'}" y todos sus hijos?`);
    if (!confirmed) return;
    deleteNode(selectedId);
    showStatus('Eliminado');
  });

  addRootBtn.addEventListener('click', () => createNode({ parentId: null, name: 'Nueva raiz' }));
  exportJsonBtn.addEventListener('click', exportJSON);

  // Ensure default GitHub path if none provided
  function ghPathOrDefault(){
    const p = (ghPath && ghPath.value && ghPath.value.trim()) ? ghPath.value.trim() : DATA_URL;
    return p;
  }

  // auto-save on input change (debounced)
  let autoSaveTimer = null;
  [nameInput, descInput, tagsInput].forEach(inp => {
    inp.addEventListener('input', () => {
      if (!selectedId) return;
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        const tags = parseTags(tagsInput.value);
        updateNode(selectedId, { name: nameInput.value, description: descInput.value, tags });
        showStatus('Auto-guardado');
      }, 700);
    });
  });

  // status helper
  let statusTimer = null;
  function showStatus(txt) {
    syncStatus.textContent = txt;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(()=> { if (syncStatus.textContent === txt) syncStatus.textContent = ''; }, 3500);
  }

  // --- Initialization with sample if empty ---
  function ensureInitial() {
    if (!nodes.length) {
      nodes = [
        { id: uid(), parentId: null, name: 'Proyectos', description: 'Carpeta principal', tags: ['inicio'], collapsed: false },
        { id: uid(), parentId: null, name: 'Documentos', description: 'Mis documentos', tags: ['docs'], collapsed: false },
      ];
      // add child to proyectos
      const proj = nodes[0];
      nodes.push({ id: uid(), parentId: proj.id, name: 'Proyecto A', description: 'Descripcion A', tags: ['proyecto','urgent'], collapsed: false });
      saveLocal();
    }
  }
  // Authentication helpers
  function setCookie(name, value, days){
    const d = new Date(); d.setTime(d.getTime() + (days*24*60*60*1000));
    const secure = (location && location.protocol === 'https:') ? ';Secure' : '';
    const sameSite = ';SameSite=Lax';
    document.cookie = name + '=' + encodeURIComponent(value) + ';path=/;expires=' + d.toUTCString() + sameSite + secure;
  }
  function getCookie(name){
    const v = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return v ? decodeURIComponent(v.pop()) : null;
  }

  function clearCookie(name){
    document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=Lax' + ((location && location.protocol === 'https:')?';Secure':'');
  }

  async function validateLogin(user, pass){
    // Validate only against data/auth.json. Do NOT fall back to hardcoded credentials.
    try{
      const res = await fetch('data/auth.json', { cache: 'no-store' });
      if (!res.ok) return false;
      const j = await res.json();
      // support either single {username,password} or an array of credentials
      if (Array.isArray(j)) {
        return j.some(u => String(u.username) === String(user) && String(u.password) === String(pass));
      }
      return (String(user) === String(j.username) && String(pass) === String(j.password));
    }catch(e){
      console.warn('validateLogin error', e);
      return false;
    }
  }

  function showLogin(){
    if (loginModal) { loginModal.setAttribute('aria-hidden','false'); }
    const appEl = $('app'); if (appEl) appEl.setAttribute('aria-hidden','true');
  }
  function hideLogin(){ if (loginModal) { loginModal.setAttribute('aria-hidden','true'); } }

  // initial load
  (function init(){
    // login first
    const user = getCookie(AUTH_COOKIE);
      if (!user) {
      showLogin();
      if (loginBtn) loginBtn.addEventListener('click', async () => {
        const u = loginUser.value.trim();
        const p = loginPass.value;
        const ok = await validateLogin(u,p);
        if (ok){ setCookie(AUTH_COOKIE,u,7); hideLogin(); proceedInit(); }
        else alert('Credenciales invalidas');
      });
      // allow Enter key
      if (loginPass) loginPass.addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); });
    } else {
      proceedInit();
    }

    // proceed to load data and render
    function proceedInit(){
      const loaded = loadLocal();
      // loadLocal may return a promise
      if (loaded && typeof loaded.then === 'function'){
        loaded.then(ok => {
          if (!ok) nodes = [];
          ensureInitial();
          buildHierarchy();
          const first = childrenOf(null)[0]; if (first) selectNode(first.id);
          syncActionState();
          // show app now
          const appEl = $('app'); if (appEl) appEl.setAttribute('aria-hidden','false');
          startInactivityWatcher();
        });
      } else {
        if (!loaded) nodes = [];
        ensureInitial();
        buildHierarchy();
        const first = childrenOf(null)[0]; if (first) selectNode(first.id);
        syncActionState();
        const appEl = $('app'); if (appEl) appEl.setAttribute('aria-hidden','false');
        startInactivityWatcher();
      }

    }
  })();

  // inactivity watcher (logout after INACTIVITY_MS)
  function resetInactivity(){
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(()=>{ doLogout('Inactividad'); }, INACTIVITY_MS);
  }
  function startInactivityWatcher(){
    resetInactivity();
    ['mousemove','keydown','click','touchstart'].forEach(ev => window.addEventListener(ev, resetInactivity));
  }

  function doLogout(reason){
    // clear cookie and sensitive fields, hide app and show login
    try { saveLocal(); } catch(e){}
    clearCookie(AUTH_COOKIE);
    if (ghToken) ghToken.value = '';
    const appEl = $('app'); if (appEl) appEl.setAttribute('aria-hidden','true');
    showLogin();
    showStatus('Sesion cerrada: ' + reason);
  }

  // keyboard shortcuts (optional)
  document.addEventListener('keydown', e => {
    if (e.key === 'n' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); createNode({ parentId: selectedId || null }); }
    if (e.key === 'Delete' && selectedId) { deleteNode(selectedId); }
  });

  // Expose some functions for debugging in console
  window._folderTree = {
    get nodes(){ return clone(nodes); },
    save: saveLocal,
    load: loadLocal,
    exportJSON
  };
})();










