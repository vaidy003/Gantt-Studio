const state = {
  tree: [],
  collapsed: new Set(),
  zoomValue: 0,
  hasLoaded: false,
};

const LEFT_COLUMN_WIDTH = 340;
const MIN_VISIBLE_MONTHS = 1;
const MAX_VISIBLE_MONTHS = 12;
const ZOOM_STORAGE_KEY = "ganttStudioZoomValue";

const COLOR_SEQUENCE = [
  "#f8bf4f",
  "#c4cb61",
  "#ff9460",
  "#4ab1d0",
  "#fb6274",
  "#8e7cff",
  "#7dd39f",
  "#7ac4ed",
];

const board = document.querySelector("#ganttBoard");
const appShell = document.querySelector(".app-shell");
const boardShell = document.querySelector(".board-shell");
const boardHeaderHost = document.querySelector("#boardHeaderHost");
const boardHeaderSpacer = document.querySelector(".board-header-spacer");
const boardScroll = document.querySelector(".board-scroll");
const topbar = document.querySelector(".topbar");
const zoomSlider = document.querySelector("#zoomSlider");
const zoomValue = document.querySelector("#zoomValue");
const addTaskButton = document.querySelector("#addTaskButton");
const backupButton = document.querySelector("#backupButton");
const importButton = document.querySelector("#importButton");
const csvFileInput = document.querySelector("#csvFileInput");
const dialog = document.querySelector("#taskDialog");
const form = document.querySelector("#taskForm");
const closeDialogButton = document.querySelector("#closeDialogButton");
const cancelDialogButton = document.querySelector("#cancelDialogButton");
const deleteTaskButton = document.querySelector("#deleteTaskButton");
const saveTaskButton = document.querySelector("#saveTaskButton");
const dialogEyebrow = document.querySelector("#dialogEyebrow");
const dialogTitle = document.querySelector("#dialogTitle");
const floatingTooltip = document.querySelector("#floatingTooltip");
const editingTaskIdInput = document.querySelector("#editingTaskId");
const levelSelect = document.querySelector("#levelSelect");
const parentSelect = document.querySelector("#parentSelect");
const titleInput = document.querySelector("#titleInput");
const assigneeInput = document.querySelector("#assigneeInput");
const startDateInput = document.querySelector("#startDateInput");
const endDateInput = document.querySelector("#endDateInput");

zoomSlider.addEventListener("input", handleZoomInput);
addTaskButton.addEventListener("click", () => openDialog());
backupButton.addEventListener("click", downloadBackup);
importButton.addEventListener("click", () => csvFileInput.click());
csvFileInput.addEventListener("change", handleCsvImport);
closeDialogButton.addEventListener("click", () => dialog.close());
cancelDialogButton.addEventListener("click", () => dialog.close());
deleteTaskButton.addEventListener("click", handleDeleteFromDialog);
levelSelect.addEventListener("change", () => syncParentOptions());
form.addEventListener("submit", submitTask);
document.addEventListener("pointermove", handleTooltipPointerMove);
document.addEventListener("mouseover", handleTooltipEnter);
document.addEventListener("mouseout", handleTooltipLeave);
document.addEventListener("focusin", handleTooltipEnter);
document.addEventListener("focusout", handleTooltipLeave);
window.addEventListener("scroll", hideTooltip, true);
window.addEventListener("resize", () => renderBoard());
boardScroll.addEventListener("scroll", syncBoardHeaderScroll);

hydrateZoom();
applyZoom();
loadTasks();

async function loadTasks() {
  const response = await fetch("/api/tasks");
  const payload = await response.json();
  state.tree = payload.tasks;
  syncCollapsedState();
  syncParentOptions();
  renderBoard();
  state.hasLoaded = true;
}

function renderBoard() {
  const visibleRows = flattenVisible(state.tree);
  if (!visibleRows.length) {
    boardHeaderHost.innerHTML = "";
    board.innerHTML = `<div class="empty-state"><h2>No tasks yet</h2><p>Add your first task to get started.</p></div>`;
    return;
  }

  const allDates = visibleRows
    .filter((row) => row.start_date && row.end_date)
    .flatMap((row) => [new Date(row.start_date), new Date(row.end_date)]);
  const { start: timelineStart, end: timelineEnd } = programYearRange(allDates);
  const monthStarts = listMonthStarts(timelineStart, timelineEnd);
  const totalWeeks = monthStarts.length * 4;
  const totalDays = daysBetween(timelineStart, timelineEnd) + 1;
  const weekWidth = currentWeekWidth(totalWeeks);
  const boardMinWidth = LEFT_COLUMN_WIDTH + totalWeeks * weekWidth;

  const timelineWidth = totalWeeks * weekWidth;
  const header = `
    <div class="board-header">
      <div class="left-header">Tasks</div>
      <div class="board-header-track">
        <div class="timeline-header" style="width:${timelineWidth}px;">
          <div class="month-row">
            ${monthStarts
              .map(
                (month) =>
                  `<div class="month-cell">${month.toLocaleString("en-US", { month: "short", year: "numeric" })}</div>`,
              )
              .join("")}
          </div>
          <div class="week-row">
            ${new Array(totalWeeks).fill(0).map((_, index) => `<div class="week-cell">W${(index % 4) + 1}</div>`).join("")}
          </div>
        </div>
      </div>
    </div>
  `;

  const rows = visibleRows
    .map((row, index) => renderRow(row, index, timelineStart, totalDays))
    .join("");

  document.documentElement.style.setProperty("--week-width", `${weekWidth}px`);
  board.style.minWidth = `${boardMinWidth}px`;
  boardHeaderHost.innerHTML = header;
  board.innerHTML = rows;
  updateChromeLayout();
  syncBoardHeaderScroll();

  board.querySelectorAll("[data-toggle-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = Number(button.dataset.toggleId);
      if (state.collapsed.has(id)) {
        state.collapsed.delete(id);
      } else {
        state.collapsed.add(id);
      }
      renderBoard();
    });
  });

  board.querySelectorAll("[data-edit-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const taskId = Number(button.dataset.editId);
      const task = findTaskById(state.tree, taskId);
      if (!task) {
        return;
      }
      openDialog(task);
    });
  });

}

function syncBoardHeaderScroll() {
  const timelineHeader = boardHeaderHost.querySelector(".timeline-header");
  if (!timelineHeader) {
    return;
  }
  timelineHeader.style.transform = `translateX(-${boardScroll.scrollLeft}px)`;
}

function updateChromeLayout() {
  const headerGap = 6;
  const topbarHeight = Math.ceil(topbar.getBoundingClientRect().height || 0);
  const shellRect = boardShell.getBoundingClientRect();
  const topbarRect = topbar.getBoundingClientRect();
  const rootStyles = getComputedStyle(document.documentElement);
  const timelineHeaderHeight = Math.round(
    parseFloat(rootStyles.getPropertyValue("--timeline-header-height")) || 96,
  );

  document.documentElement.style.setProperty("--app-header-height", `${topbarHeight}px`);
  document.documentElement.style.setProperty("--board-shell-left", `${Math.round(shellRect.left)}px`);
  document.documentElement.style.setProperty("--board-shell-width", `${Math.round(shellRect.width)}px`);

  appShell.style.paddingTop = `${topbarHeight + headerGap}px`;
  boardHeaderHost.style.top = `${Math.round(topbarRect.bottom + headerGap)}px`;
  boardHeaderHost.style.left = `${Math.round(shellRect.left)}px`;
  boardHeaderHost.style.width = `${Math.round(shellRect.width)}px`;
  boardHeaderSpacer.style.height = `${Math.max(0, timelineHeaderHeight - 1)}px`;
}

function renderRow(row, index, timelineStart, totalDays) {
  const color = COLOR_SEQUENCE[row.rootIndex % COLOR_SEQUENCE.length];
  const hasChildren = row.children.length > 0;
  const isCollapsed = state.collapsed.has(row.id);
  const hasDates = Boolean(row.start_date && row.end_date);
  const left = hasDates
    ? ((daysBetween(timelineStart, new Date(row.start_date)) / totalDays) * 100).toFixed(3)
    : "0";
  const width = hasDates
    ? (((daysBetween(new Date(row.start_date), new Date(row.end_date)) + 1) / totalDays) * 100).toFixed(3)
    : "0";
  const dateLabel = hasDates ? `${formatDate(row.start_date)} - ${formatDate(row.end_date)}` : "No dates set";
  const canEdit = row.depth === 1;
  const trackContent =
    row.depth === 0 && hasChildren
      ? renderSummaryBar(row, color, timelineStart, totalDays, dateLabel)
      : !hasDates
      ? ""
      : `
        <div
          class="task-bar"
          data-tooltip="${escapeHtml(`${row.assignee_email} • ${dateLabel}`)}"
          tabindex="0"
          style="left:${left}%; width:${width}%; background:${color};"
        ></div>
      `;

  return `
    <div class="task-row depth-${Math.min(row.depth, 2)}">
      <div class="task-side depth-${Math.min(row.depth, 2)}">
        ${new Array(row.depth).fill('<div class="task-indent"></div>').join("")}
        ${
          hasChildren
            ? `<button class="toggle-button" data-toggle-id="${row.id}" type="button">${isCollapsed ? "+" : "−"}</button>`
            : '<div class="toggle-spacer"></div>'
        }
        <div class="task-title-wrap" data-tooltip="${escapeHtml(dateLabel)}" tabindex="0">
          <div class="task-title">${escapeHtml(row.title)}</div>
        </div>
        ${
          canEdit
            ? `<button class="delete-button" data-edit-id="${row.id}" type="button" aria-label="Edit sub task" title="Edit sub task">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm14.71-9.04a1 1 0 0 0 0-1.41l-2.5-2.5a1 1 0 0 0-1.41 0l-1.84 1.84 3.75 3.75 1.84-1.68z"></path>
                </svg>
              </button>`
            : ""
        }
      </div>
      <div class="task-track">
        ${trackContent}
      </div>
    </div>
  `;
}

function renderSummaryBar(row, color, timelineStart, totalDays, dateLabel) {
  if (!(row.start_date && row.end_date)) {
    return "";
  }
  const baseLeft = percentFromDate(row.start_date, timelineStart, totalDays);
  const baseWidth = percentFromRange(row.start_date, row.end_date, totalDays);
  const childSegments = row.children
    .filter((child) => child.start_date && child.end_date)
    .map((child) => {
      const childLeft = percentFromDate(child.start_date, timelineStart, totalDays);
      const childWidth = Math.max(percentFromRange(child.start_date, child.end_date, totalDays), 0.9);
      const childLabel = `${child.title} • ${formatDate(child.start_date)} - ${formatDate(child.end_date)}`;
      return `
        <div
          class="summary-segment"
          data-tooltip="${escapeHtml(childLabel)}"
          tabindex="0"
          style="left:${childLeft}%; width:${childWidth}%; background:${color};"
        ></div>
      `;
    })
    .join("");

  return `
    <div class="task-summary">
      <div
        class="summary-range"
        data-tooltip="${escapeHtml(`${row.title} • ${dateLabel}`)}"
        tabindex="0"
        style="left:${baseLeft}%; width:${baseWidth}%; background:${color};"
      ></div>
      ${childSegments}
    </div>
  `;
}

function flattenVisible(tree) {
  const rows = [];

  function walk(nodes, depth, rootIndex) {
    nodes.forEach((node, index) => {
      const currentRootIndex = depth === 0 ? index : rootIndex;
      rows.push({ ...node, depth, rootIndex: currentRootIndex });
      if (!state.collapsed.has(node.id) && node.children.length) {
        walk(node.children, depth + 1, currentRootIndex);
      }
    });
  }

  walk(tree, 0, 0);
  return rows;
}

function collectExpandableIds(nodes) {
  const ids = [];

  function walk(items) {
    items.forEach((item) => {
      if (item.children.length) {
        ids.push(item.id);
        walk(item.children);
      }
    });
  }

  walk(nodes);
  return ids;
}

function syncCollapsedState() {
  const expandableIds = new Set(collectExpandableIds(state.tree));

  if (!state.hasLoaded) {
    state.collapsed = expandableIds;
    return;
  }

  state.collapsed = new Set(
    [...state.collapsed].filter((id) => expandableIds.has(id))
  );
}

function openDialog(task = null) {
  form.reset();
  assigneeInput.value = "prasad@aeee.in";
  editingTaskIdInput.value = task ? String(task.id) : "";
  dialogEyebrow.textContent = task ? "Update Item" : "Create Item";
  dialogTitle.textContent = task ? "Edit Task" : "Add Task";
  saveTaskButton.textContent = task ? "Save Changes" : "Save Task";

  if (task) {
    levelSelect.value = task.parent_id == null ? "task" : "subtask";
    syncParentOptions(task);
    titleInput.value = task.title;
    assigneeInput.value = task.assignee_email;
    startDateInput.value = task.manual_start_date || task.start_date || "";
    endDateInput.value = task.manual_end_date || task.end_date || "";
    deleteTaskButton.hidden = task.parent_id == null;
    deleteTaskButton.dataset.taskId = String(task.id);
    deleteTaskButton.dataset.taskTitle = task.title;
  } else {
    levelSelect.value = "task";
    syncParentOptions();
    deleteTaskButton.hidden = true;
    deleteTaskButton.dataset.taskId = "";
    deleteTaskButton.dataset.taskTitle = "";
  }

  dialog.showModal();
  titleInput.focus();
}

function syncParentOptions(currentTask = null) {
  const level = levelSelect.value;
  const options = [];

  if (level === "task") {
    options.push({ value: "", label: "No parent" });
  }

  if (level === "subtask") {
    state.tree.forEach((node) => {
      if (currentTask && node.id === currentTask.id) {
        return;
      }
      options.push({ value: String(node.id), label: node.title });
    });
  }

  parentSelect.innerHTML = options
    .map((option) => `<option value="${option.value}">${escapeHtml(option.label)}</option>`)
    .join("");

  parentSelect.disabled = level === "task";

  if (currentTask) {
    parentSelect.value = currentTask.parent_id == null ? "" : String(currentTask.parent_id);
  }
}

async function submitTask(event) {
  event.preventDefault();
  const payload = {
    title: titleInput.value,
    assignee_email: assigneeInput.value,
    start_date: startDateInput.value,
    end_date: endDateInput.value,
    parent_id: parentSelect.disabled ? null : parentSelect.value || null,
  };

  const editingTaskId = editingTaskIdInput.value;
  const response = await fetch(editingTaskId ? `/api/tasks/${editingTaskId}/update` : "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) {
    window.alert(result.error || "Could not save task.");
    return;
  }

  dialog.close();
  await loadTasks();
}

async function runSimpleAction(url, successText) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const payload = await response.json();
  await loadTasks();
}

async function handleCsvImport(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    const csvText = await file.text();
    const response = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv_text: csvText }),
    });
    const result = await response.json();
    if (!response.ok) {
      window.alert(result.error || "Could not import CSV.");
      return;
    }
    state.hasLoaded = false;
    await loadTasks();
  } finally {
    csvFileInput.value = "";
  }
}

async function deleteSubtask(taskId) {
  const response = await fetch(`/api/tasks/${taskId}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const result = await response.json();
  if (!response.ok) {
    window.alert(result.error || "Could not delete task.");
    return;
  }
  await loadTasks();
}

async function handleDeleteFromDialog() {
  const taskId = Number(deleteTaskButton.dataset.taskId);
  const taskTitle = deleteTaskButton.dataset.taskTitle || "this sub task";
  if (!taskId) {
    return;
  }
  const confirmed = window.confirm(`Delete "${taskTitle}"?`);
  if (!confirmed) {
    return;
  }
  dialog.close();
  await deleteSubtask(taskId);
}

function downloadBackup() {
  window.location.href = "/api/backup";
}

function hydrateZoom() {
  const saved = Number(window.localStorage.getItem(ZOOM_STORAGE_KEY));
  if (Number.isFinite(saved) && saved >= 0 && saved <= 100) {
    state.zoomValue = saved;
  }
}

function visibleMonthsFromZoom() {
  const ratio = state.zoomValue / 100;
  return MAX_VISIBLE_MONTHS - ratio * (MAX_VISIBLE_MONTHS - MIN_VISIBLE_MONTHS);
}

function percentFromDate(value, timelineStart, totalDays) {
  return ((daysBetween(timelineStart, new Date(value)) / totalDays) * 100).toFixed(3);
}

function percentFromRange(start, end, totalDays) {
  return ((((daysBetween(new Date(start), new Date(end)) + 1) / totalDays) * 100)).toFixed(3);
}

function applyZoom() {
  zoomSlider.value = String(state.zoomValue);
  zoomValue.textContent = `${Math.round(visibleMonthsFromZoom())} mo`;
}

function handleZoomInput(event) {
  state.zoomValue = Number(event.target.value);
  window.localStorage.setItem(ZOOM_STORAGE_KEY, String(state.zoomValue));
  applyZoom();
  renderBoard();
}

function currentWeekWidth(totalWeeks) {
  const visibleMonths = visibleMonthsFromZoom();
  const visibleTimelineWidth = Math.max(240, boardScroll.clientWidth - LEFT_COLUMN_WIDTH - 12);
  const visibleWeeks = (totalWeeks / MAX_VISIBLE_MONTHS) * visibleMonths;
  return visibleTimelineWidth / Math.max(1, visibleWeeks);
}

function minDate(dates) {
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

function maxDate(dates) {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function programYearRange(dates) {
  return {
    start: new Date(2026, 6, 1),
    end: new Date(2027, 5, 30),
  };
}

function alignToMonthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function alignToMonthEnd(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function listMonthStarts(start, end) {
  const months = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= end) {
    months.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function daysBetween(start, end) {
  const oneDay = 24 * 60 * 60 * 1000;
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((endUtc - startUtc) / oneDay);
}

function formatDate(value) {
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function handleTooltipEnter(event) {
  const target = event.target.closest("[data-tooltip]");
  if (!target || target.classList.contains("tooltip-button")) {
    return;
  }
  showTooltip(target, target.dataset.tooltip);
}

function handleTooltipLeave(event) {
  const target = event.target.closest("[data-tooltip]");
  if (!target || target.classList.contains("tooltip-button")) {
    return;
  }
  const nextTarget = event.relatedTarget?.closest?.("[data-tooltip]");
  if (nextTarget === target) {
    return;
  }
  hideTooltip();
}

function handleTooltipPointerMove(event) {
  const target = event.target.closest("[data-tooltip]");
  if (!target || target.classList.contains("tooltip-button")) {
    return;
  }
  positionTooltip(event.clientX, event.clientY);
}

function showTooltip(target, text) {
  if (!text) {
    hideTooltip();
    return;
  }
  floatingTooltip.textContent = text;
  floatingTooltip.dataset.owner = String(target.dataset.tooltip || "");
  floatingTooltip.classList.add("is-visible");
  const rect = target.getBoundingClientRect();
  positionTooltip(rect.left + Math.min(rect.width / 2, 120), rect.bottom);
}

function hideTooltip() {
  floatingTooltip.classList.remove("is-visible");
  floatingTooltip.style.transform = "translate(-9999px, -9999px)";
  delete floatingTooltip.dataset.owner;
}

function positionTooltip(clientX, clientY) {
  if (!floatingTooltip.classList.contains("is-visible")) {
    return;
  }

  const margin = 12;
  const tooltipRect = floatingTooltip.getBoundingClientRect();
  const maxX = window.innerWidth - tooltipRect.width - margin;
  const maxY = window.innerHeight - tooltipRect.height - margin;
  const x = Math.min(Math.max(margin, clientX + 10), Math.max(margin, maxX));
  const y = Math.min(Math.max(margin, clientY + 16), Math.max(margin, maxY));
  floatingTooltip.style.transform = `translate(${x}px, ${y}px)`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function findTaskById(nodes, taskId) {
  for (const node of nodes) {
    if (node.id === taskId) {
      return node;
    }
    const childMatch = findTaskById(node.children || [], taskId);
    if (childMatch) {
      return childMatch;
    }
  }
  return null;
}
