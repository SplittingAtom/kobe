---
title: Storage limits
summary: How big a file can be and how many files and bytes My files, projects, uploads and the whole workspace can hold, and where the files are stored.
section: Files and editing
order: 4
audience: member
---

Kobe limits files, file counts and bytes. It does not limit folders: make as many as you like,
nested as deep as you like. The numbers below are Kobe's defaults; your site can set different
ones, and the workspace's own storage page shows what applies to you.

## At a glance

| Where                         | Largest file                | Files                | Bytes                        |
| ----------------------------- | --------------------------- | -------------------- | ---------------------------- |
| **My files**                  | 1 GiB backed up (see below) | 100,000 per person   | 10 GiB per person (volume)   |
| **A project**                 | 50 MiB                      | 500 in the file tree | counts against the workspace |
| **Message attachments**       | 100 MiB                     | 100 per message      | 500 MiB per message          |
| **The workspace (all above)** | —                           | 2,000,000 objects    | 50 GiB storage quota         |

## My files

My files is your own volume, mounted at `/workspace` in every conversation's sandbox.

- **Size:** 10 GiB per person.
- **Files:** up to 100,000.
- **Backup:** Kobe copies your files to the site's object storage about once a minute, after every
  run and before your sandbox sleeps, so they come back when it wakes or moves to another machine.
  Files larger than 1 GiB are not copied: they stay on the volume only and are lost if the volume
  is. Keep anything that large somewhere else as well.
- **Editing:** text files up to 1 MB open in the editor; larger ones open read-only. See
  [Editing files](file-editor.md).

## Projects

Projects are shared and versioned, so their limits are tighter than My files:

- **Largest file:** 50 MiB (or the site's attachment limit, if lower).
- **Files:** 500 in a project's file tree.
- **History:** at most 1,000 commits are kept per project; a team admin can keep fewer (by count or
  by age) under **Workspace settings → Storage and history**.

A My files folder with a file over 50 MiB, or more than 500 files, cannot be promoted to a project
as it is. Older versions of a project's files count against the workspace's storage until the
history that holds them is dropped.

## Message attachments

Each file you attach to a message can be up to 100 MiB, and one message can carry up to 100 files
and 500 MiB in total. Attachments land in `uploads/<thread>/` in My files and count against the
workspace's storage quota. See [The composer](../chat/composer.md).

## The workspace quota

Everything above adds up against two limits for the whole workspace (your team):

- **Storage quota: 50 GiB.** Attachments, the backed-up copy of every member's My files and every
  project's files and history count towards it.
- **Object budget: 2,000,000 stored objects** across the same places. A team admin can change it
  under **Workspace settings → Storage and history**.

Past either limit, new attachments, My files backups and project commits are refused with a
message that the workspace's storage quota (or object budget) is full. Nothing already stored is
removed. Free space by deleting files, dropping project history, or asking a team admin.

## Where your files are stored

- **My files** live on your sandbox's own disk volume while you work, with the backup copy in the
  site's S3-compatible object storage.
- **Projects** and **attachments** are stored in that object storage only, as content-addressed
  objects (identical files are stored once); Kobe's database keeps their names, folders, versions
  and who may see them.

Every workspace's objects are kept apart under the workspace's own prefix, and sandboxes never hold
storage credentials: the Kobe server moves the bytes.

## Related

- [Workspaces, My files and projects](workspaces-and-projects.md)
- [Editing files](file-editor.md)
- [Team admin guide](../admin/team-admin.md)
