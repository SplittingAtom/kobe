"use client";

import Link from "next/link";
import { listSkills } from "../../../../lib/admin/api/team/skills";
import { useTeamAccess } from "../../console-context";
import { skillPaths, type SkillArea } from "./area";
import { DateTime, ResourceView } from "../../parts";
import { useResource } from "../../use-resource";
import styles from "../../admin.module.css";

/**
 * Skills the caller can see; each one opens in the editor (KOBE-83). In the member's own area
 * (`area="my"`, KOBE-98) it lists personal skills only.
 */
export function SkillsPage({ area = "team" }: { readonly area?: SkillArea }) {
  const teamId = useTeamAccess().team.id;
  const paths = skillPaths(area);
  const { state } = useResource(() => listSkills(teamId, paths.listScope));
  return (
    <>
      <h1>{paths.listTitle}</h1>
      <p className={styles.hint}>
        Saving a skill creates a new immutable version.{" "}
        {area === "my"
          ? "Personal skills are only yours."
          : "Team skills are shared with the team; personal skills are only yours."}
      </p>
      <p>
        <Link href={`${paths.base}/new`}>New skill</Link>
      </p>
      <ResourceView state={state} label="skills">
        {(skills) =>
          skills.length === 0 ? (
            <p>No skills yet.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>{paths.listTitle}</caption>
                <thead>
                  <tr>
                    <th scope="col">Skill</th>
                    {area === "team" && <th scope="col">Scope</th>}
                    <th scope="col">Latest version</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {skills.map((s) => (
                    <tr key={s.id}>
                      <th scope="row">
                        <Link href={`${paths.base}/${s.id}`}>{s.slug}</Link>
                        <div className={styles.hint}>{s.description}</div>
                      </th>
                      {area === "team" && <td>{s.scope === "team" ? "Team" : "Personal"}</td>}
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
