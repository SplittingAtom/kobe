"use client";

import Link from "next/link";
import { listSkills } from "../../../../lib/admin/api/team/skills";
import { useTeamAccess } from "../../console-context";
import { DateTime, ResourceView } from "../../parts";
import { useResource } from "../../use-resource";
import styles from "../../admin.module.css";

/** Skills the caller can see (team and personal); each one opens in the editor (KOBE-83). */
export function SkillsPage() {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => listSkills(teamId));
  return (
    <>
      <h1>Skills</h1>
      <p className={styles.hint}>
        Saving a skill creates a new immutable version. Team skills are shared with the team;
        personal skills are only yours.
      </p>
      <p>
        <Link href="/admin/team/skills/new">New skill</Link>
      </p>
      <ResourceView state={state} label="skills">
        {(skills) =>
          skills.length === 0 ? (
            <p>No skills yet.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Skills</caption>
                <thead>
                  <tr>
                    <th scope="col">Skill</th>
                    <th scope="col">Scope</th>
                    <th scope="col">Latest version</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {skills.map((s) => (
                    <tr key={s.id}>
                      <th scope="row">
                        <Link href={`/admin/team/skills/${s.id}`}>{s.slug}</Link>
                        <div className={styles.hint}>{s.description}</div>
                      </th>
                      <td>{s.scope === "team" ? "Team" : "Personal"}</td>
                      <td>v{s.latestVersion}</td>
                      <td>
                        <DateTime value={s.updatedAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
    </>
  );
}
