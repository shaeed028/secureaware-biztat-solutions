// Training Needs Matrix: maps roles and departments to required courses and turns those
// requirements into per-user assignments. Reconciliation runs at start-up, on login (which
// covers new users and role or department changes), when the matrix is saved and when a
// course is published.
import { addDays } from "./store.js";

export function createMatrix(db, notify) {
  const q = {
    requirementsFor: db.prepare(`SELECT r.course_id, MIN(r.due_in_days) AS due_in_days, c.title, c.slug FROM training_role_requirements r
      JOIN training_courses c ON c.id = r.course_id
      WHERE c.status = 'published' AND (r.role = '*' OR r.role = ?) AND (r.department IS NULL OR r.department = ?)
      GROUP BY r.course_id, c.title, c.slug`),
    insertAssignment: db.prepare(`INSERT OR IGNORE INTO training_assignments (course_id,target_type,target_value,due_date,mandatory,source,assigned_by,created_at)
      VALUES (?,'user',?,?,1,'matrix',NULL,?)`),
    matrixAssignments: db.prepare("SELECT id, course_id FROM training_assignments WHERE source = 'matrix' AND target_type = 'user' AND target_value = ?"),
    hasPassed: db.prepare("SELECT 1 FROM quiz_attempts WHERE user_id = ? AND course_id = ? AND passed = 1 LIMIT 1"),
    deleteAssignment: db.prepare("DELETE FROM training_assignments WHERE id = ?"),
    activeUsers: db.prepare("SELECT id, username, role, department FROM users WHERE active = 1")
  };

  function reconcileUser(user) {
    const required = q.requirementsFor.all(user.role, user.department);
    const requiredIds = new Set(required.map((row) => row.course_id));
    let created = 0;
    for (const requirement of required) {
      const result = q.insertAssignment.run(requirement.course_id, String(user.id), addDays(requirement.due_in_days), new Date().toISOString());
      if (result.changes) {
        created += 1;
        notify(user.id, "training", `New mandatory training: ${requirement.title}`,
          `This course is required for your role or department. Please complete it within ${requirement.due_in_days} days.`, `#/training/${requirement.slug}`);
      }
    }
    // After a role or department change, drop matrix assignments that no longer apply,
    // unless the learner already passed (their completion stays on record either way).
    let removed = 0;
    for (const assignment of q.matrixAssignments.all(String(user.id))) {
      if (!requiredIds.has(assignment.course_id) && !q.hasPassed.get(user.id, assignment.course_id)) {
        q.deleteAssignment.run(assignment.id);
        removed += 1;
      }
    }
    return { created, removed };
  }

  function reconcileAll() {
    const totals = { created: 0, removed: 0, users: 0 };
    for (const user of q.activeUsers.all()) {
      const result = reconcileUser(user);
      totals.created += result.created;
      totals.removed += result.removed;
      totals.users += 1;
    }
    return totals;
  }

  return { reconcileUser, reconcileAll };
}
