import { useState } from "react";
import { admin, type ScheduledTask } from "../../admin";
import { IconPlay, IconStop } from "../../icons";
import { useClient } from "../../session";
import { ago, errorText, fullDate, spanBetween, usePoll } from "./ui";

/** Every scheduled task, polled quickly while any of them runs. */
export function useTasks() {
  const client = useClient();
  const [fast, setFast] = useState(false);
  const poll = usePoll(
    async () => {
      const list = await admin.tasks(client);
      setFast(list.some((task) => task.State !== "Idle"));
      return list;
    },
    fast ? 2000 : 15000,
    "tasks",
  );
  return poll;
}

export function TasksSection() {
  const client = useClient();
  const { data, error, loading, reload } = useTasks();
  const [pending, setPending] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [filter, setFilter] = useState("");

  const act = (task: ScheduledTask, stop: boolean) => {
    setPending(task.Id);
    setNotice(null);
    (stop ? admin.stopTask(client, task.Id) : admin.startTask(client, task.Id))
      .then(() => {
        setNotice({ tone: "ok", text: stop ? `Stopping ${task.Name}.` : `Started ${task.Name}.` });
        window.setTimeout(() => void reload(), 600);
      })
      .catch((err: unknown) => setNotice({ tone: "error", text: `${task.Name}: ${errorText(err)}` }))
      .finally(() => setPending(""));
  };

  const query = filter.trim().toLowerCase();
  const tasks = (data ?? []).filter((task) => !task.IsHidden && (!query || `${task.Name} ${task.Category} ${task.Description}`.toLowerCase().includes(query)));
  const groups = new Map<string, ScheduledTask[]>();
  for (const task of tasks) {
    const category = task.Category || "Other";
    groups.set(category, [...(groups.get(category) ?? []), task]);
  }
  const running = tasks.filter((task) => task.State !== "Idle");
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <div>
          <h2>
            Scheduled tasks {running.length ? <span className="count-pill">{running.length} running</span> : null}
          </h2>
          <p>Maintenance and library jobs the server runs on a schedule. Running one here starts it now.</p>
        </div>
        <input className="dash-search" type="search" placeholder="Filter tasks" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      {notice ? <p className={`dash-inline-note ${notice.tone === "ok" ? "ok-text" : "error-text"}`}>{notice.text}</p> : null}
      {error && !data ? <p className="dash-empty error-text">Couldn't load tasks. {error}</p> : null}
      {!data && loading ? <p className="dash-empty">Loading tasks…</p> : null}
      {data && tasks.length === 0 ? <p className="dash-empty">No tasks match.</p> : null}
      <div className="dash-task-groups">
        {ordered.map(([category, list]) => (
          <div key={category} className="dash-card dash-list">
            <h3 className="dash-list-title">{category}</h3>
            {list
              .sort((a, b) => a.Name.localeCompare(b.Name))
              .map((task) => (
                <TaskRow key={task.Id} task={task} pending={pending === task.Id} onRun={() => act(task, false)} onStop={() => act(task, true)} />
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}

export function TaskRow({ task, pending, onRun, onStop }: { task: ScheduledTask; pending: boolean; onRun: () => void; onStop: () => void }) {
  const active = task.State !== "Idle";
  const percent = Math.round(task.CurrentProgressPercentage ?? 0);
  const last = task.LastExecutionResult;
  const failed = last?.Status && last.Status !== "Completed";
  return (
    <div className={`dash-row dash-task${active ? " running" : ""}`}>
      <span className="dash-row-main">
        <strong>{task.Name}</strong>
        {active ? (
          <span className="dash-task-progress">
            <span className="dash-bar small">
              <span style={{ width: `${percent}%` }} />
            </span>
            <small>{task.State === "Cancelling" ? "Stopping…" : `${percent}%`}</small>
          </span>
        ) : (
          <small title={task.Description}>{task.Description}</small>
        )}
      </span>
      <span className="dash-row-side" title={last?.EndTimeUtc ? fullDate(last.EndTimeUtc) : undefined}>
        {active ? (
          <span className="dash-status">{task.State === "Cancelling" ? "Stopping" : "Running"}</span>
        ) : last?.EndTimeUtc ? (
          <>
            <span className={failed ? "dash-status bad" : "dash-status"}>{failed ? last.Status : "Ran"}</span> {ago(last.EndTimeUtc)}
            {spanBetween(last.StartTimeUtc, last.EndTimeUtc) ? <small> · took {spanBetween(last.StartTimeUtc, last.EndTimeUtc)}</small> : null}
          </>
        ) : (
          <span className="dash-faint">Never run</span>
        )}
      </span>
      {active ? (
        <button className="dash-control" aria-label={`Stop ${task.Name}`} title="Stop" disabled={pending || task.State === "Cancelling"} onClick={onStop}>
          <IconStop size={15} />
        </button>
      ) : (
        <button className="dash-control" aria-label={`Run ${task.Name}`} title="Run now" disabled={pending} onClick={onRun}>
          <IconPlay size={15} />
        </button>
      )}
    </div>
  );
}
