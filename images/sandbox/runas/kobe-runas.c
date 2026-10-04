/*
 * kobe-runas: start a program as one of the sandbox's Pi identities (KOBE-71).
 *
 *   kobe-runas <uid> <program> [args...]   exec <program> as <uid>
 *   kobe-runas <uid> --kill-all            SIGKILL every process of <uid> (slot reclaim)
 *   kobe-runas <uid> --probe-ptrace        as <uid>, a child tries to ptrace its parent and read
 *                                          its memory: exit 0 only if both are refused (Yama)
 *
 * kobe-sandbox-agent runs as KOBE_AGENT_UID; every Pi process and the tools it runs get their own
 * uid from [KOBE_SLOT_UID_MIN, KOBE_SLOT_UID_MAX] (gid = uid, the one supplementary group the
 * shared /workspace group), so a thread's tools cannot read the agent's files, write another
 * thread's runtime directory, or signal/ptrace the agent or another thread's processes.
 *
 * Privilege: the file carries the capabilities cap_setuid,cap_setgid (permitted + effective) and
 * is mode 0750 root:KOBE_AGENT_GID, so only the agent can execute it (a Pi uid is not in that
 * group, and the caller's uid is checked again below). Under gVisor these are capabilities of the
 * sandboxed kernel only. The target runs with no capabilities at all and no_new_privs set, so
 * neither it nor anything it starts can gain privileges again (no file capability, no setuid bit).
 * The bounding set is left as the pod gave it (SETUID, SETGID): dropping it needs CAP_SETPCAP,
 * which the container does not have, and with no_new_privs nothing can gain from it.
 * RLIMIT_NPROC is lowered to KOBE_SLOT_NPROC for the program (counted per uid: one runaway thread
 * cannot exhaust the sandbox's processes, and --kill-all, which does not fork, always runs).
 *
 * Deliberately tiny: no environment handling (the caller passes Pi's allow-listed environment and
 * the loader runs this file in secure-execution mode anyway), no file descriptor handling (Pi's
 * stdio and its policy socket on fd 3 are inherited as they are), no path lookup beyond execvp.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <grp.h>
#include <linux/capability.h>
#include <signal.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef KOBE_AGENT_UID
#define KOBE_AGENT_UID 1000
#endif
#ifndef KOBE_WORKSPACE_GID
#define KOBE_WORKSPACE_GID 1000
#endif
#ifndef KOBE_SLOT_UID_MIN
#define KOBE_SLOT_UID_MIN 2000
#endif
#ifndef KOBE_SLOT_UID_MAX
#define KOBE_SLOT_UID_MAX 2063
#endif

#ifndef KOBE_SLOT_NPROC
#define KOBE_SLOT_NPROC 1024
#endif

#define EXIT_USAGE 64
#define EXIT_REFUSED 77
#define EXIT_FAILED 71

static int fail(const char *what) {
  fprintf(stderr, "kobe-runas: %s: %s\n", what, strerror(errno));
  return EXIT_FAILED;
}

/* A slot uid: decimal digits only, inside the configured range. */
static int parse_uid(const char *text, uid_t *out) {
  if (text == NULL || *text == '\0' || strlen(text) > 10) return -1;
  unsigned long value = 0;
  for (const char *p = text; *p != '\0'; p++) {
    if (*p < '0' || *p > '9') return -1;
    value = value * 10 + (unsigned long)(*p - '0');
  }
  if (value < KOBE_SLOT_UID_MIN || value > KOBE_SLOT_UID_MAX) return -1;
  *out = (uid_t)value;
  return 0;
}

static int drop_capabilities(void) {
  struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct data[_LINUX_CAPABILITY_U32S_3];
  memset(data, 0, sizeof data);
  if (syscall(SYS_capset, &header, data) != 0) return -1;
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0 && errno != EINVAL) return -1;
  memset(data, 0xff, sizeof data);
  if (syscall(SYS_capget, &header, data) != 0) return -1;
  for (int i = 0; i < _LINUX_CAPABILITY_U32S_3; i++) {
    if (data[i].effective != 0 || data[i].permitted != 0 || data[i].inheritable != 0) {
      errno = EPERM;
      return -1;
    }
  }
  return 0;
}

static int become(uid_t uid) {
  const gid_t gid = (gid_t)uid;
  const gid_t groups[1] = {KOBE_WORKSPACE_GID};
  if (setgroups(1, groups) != 0) return fail("setgroups");
  if (setresgid(gid, gid, gid) != 0) return fail("setresgid");
  if (setresuid(uid, uid, uid) != 0) return fail("setresuid");
  if (drop_capabilities() != 0) return fail("dropping capabilities");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return fail("no_new_privs");
  /* Verify rather than trust: every id is the target, and the agent's uid cannot come back. */
  uid_t ru, eu, su;
  gid_t rg, eg, sg;
  gid_t now[2];
  if (getresuid(&ru, &eu, &su) != 0 || getresgid(&rg, &eg, &sg) != 0) return fail("getres*id");
  if (ru != uid || eu != uid || su != uid || rg != gid || eg != gid || sg != gid) {
    fprintf(stderr, "kobe-runas: identity not fully switched\n");
    return EXIT_FAILED;
  }
  if (getgroups(2, now) != 1 || now[0] != KOBE_WORKSPACE_GID) {
    fprintf(stderr, "kobe-runas: supplementary groups not as expected\n");
    return EXIT_FAILED;
  }
  if (setresuid(KOBE_AGENT_UID, KOBE_AGENT_UID, KOBE_AGENT_UID) == 0) {
    fprintf(stderr, "kobe-runas: could switch back to the agent's uid\n");
    return EXIT_FAILED;
  }
  return 0;
}

/*
 * Whether a process other than this one, running as `uid`, is still alive (not a zombie waiting
 * to be reaped: kill() keeps "succeeding" on those). Reads the real uid from /proc/<pid>/status
 * (the owner of /proc/<pid> turns root for a non-dumpable process) and the state from stat.
 */
static int others_alive(uid_t uid) {
  DIR *proc = opendir("/proc");
  if (proc == NULL) return 1;
  const pid_t self = getpid();
  int alive = 0;
  struct dirent *entry;
  while (!alive && (entry = readdir(proc)) != NULL) {
    char *end;
    const long pid = strtol(entry->d_name, &end, 10);
    if (*entry->d_name == '\0' || *end != '\0' || pid <= 0 || pid == self) continue;
    char path[64];
    char line[256];
    long real = -1;
    snprintf(path, sizeof path, "/proc/%ld/status", pid);
    FILE *status = fopen(path, "r");
    if (status == NULL) continue;
    while (fgets(line, sizeof line, status) != NULL) {
      if (strncmp(line, "Uid:", 4) == 0) {
        real = strtol(line + 4, NULL, 10);
        break;
      }
    }
    fclose(status);
    if (real != (long)uid) continue;
    snprintf(path, sizeof path, "/proc/%ld/stat", pid);
    FILE *file = fopen(path, "r");
    if (file == NULL) continue;
    char buffer[512];
    const size_t n = fread(buffer, 1, sizeof buffer - 1, file);
    fclose(file);
    buffer[n] = '\0';
    const char *paren = strrchr(buffer, ')');
    /* "pid (comm) S ...": the state follows the last ") ". */
    if (paren != NULL && paren[1] == ' ' && paren[2] != 'Z' && paren[2] != 'X') alive = 1;
  }
  closedir(proc);
  return alive;
}

/* SIGKILL every process of this uid (kill(-1) never signals the caller itself) until none is left. */
static int kill_all(uid_t uid) {
  const struct timespec pause = {0, 5 * 1000 * 1000};
  for (int round = 0; round < 400; round++) {
    if (kill(-1, SIGKILL) != 0) {
      if (errno == ESRCH) return 0;
      return fail("kill");
    }
    if (!others_alive(uid)) return 0;
    nanosleep(&pause, NULL);
  }
  fprintf(stderr, "kobe-runas: processes of this uid keep appearing\n");
  return EXIT_FAILED;
}

/*
 * A tool runs as its Pi's uid; only Yama (ptrace_scope >= 1) keeps it from ptracing Pi, its
 * ancestor, or reading Pi's memory (where kobe-policy and its socket live). Checked by doing it:
 * a child of this process (same uid) tries both against its parent.
 */
static int probe_ptrace(void) {
  /* Like Pi after its exec: dumpable (this file's capabilities made the helper non-dumpable, and
   * the kernel never lets a non-root process ptrace a non-dumpable one, Yama or not). */
  if (prctl(PR_SET_DUMPABLE, 1, 0, 0, 0) != 0) return fail("dumpable");
  const pid_t child = fork();
  if (child < 0) return fail("fork");
  if (child == 0) {
    const pid_t parent = getppid();
    int attached = 0;
    if (ptrace(PTRACE_ATTACH, parent, NULL, NULL) == 0) {
      attached = 1;
      waitpid(parent, NULL, __WALL);
      ptrace(PTRACE_DETACH, parent, NULL, NULL);
    }
    char path[64];
    snprintf(path, sizeof path, "/proc/%ld/mem", (long)parent);
    FILE *mem = fopen(path, "r");
    int readable = 0;
    if (mem != NULL) {
      char byte;
      readable = fseek(mem, (long)(uintptr_t)&path, SEEK_SET) == 0 && fread(&byte, 1, 1, mem) == 1;
      fclose(mem);
    }
    _exit(attached || readable ? 1 : 0);
  }
  int status = 0;
  if (waitpid(child, &status, 0) != child) return fail("waitpid");
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    fprintf(stderr, "kobe-runas: a process can ptrace or read the memory of its parent\n");
    return EXIT_FAILED;
  }
  return 0;
}

static int limit_processes(void) {
  struct rlimit limit;
  if (getrlimit(RLIMIT_NPROC, &limit) != 0) return fail("getrlimit");
  const rlim_t wanted = KOBE_SLOT_NPROC;
  if (limit.rlim_max == RLIM_INFINITY || limit.rlim_max > wanted) limit.rlim_max = wanted;
  if (limit.rlim_cur == RLIM_INFINITY || limit.rlim_cur > limit.rlim_max) {
    limit.rlim_cur = limit.rlim_max;
  }
  if (setrlimit(RLIMIT_NPROC, &limit) != 0) return fail("setrlimit");
  return 0;
}

int main(int argc, char **argv) {
  if (getuid() != KOBE_AGENT_UID || geteuid() != KOBE_AGENT_UID) {
    fprintf(stderr, "kobe-runas: only the sandbox agent may use this\n");
    return EXIT_REFUSED;
  }
  uid_t uid;
  if (argc < 3 || parse_uid(argv[1], &uid) != 0) {
    fprintf(stderr,
            "usage: kobe-runas <uid %d-%d> (<program> [args...] | --kill-all | --probe-ptrace)\n",
            KOBE_SLOT_UID_MIN, KOBE_SLOT_UID_MAX);
    return EXIT_USAGE;
  }
  const int kill_mode = strcmp(argv[2], "--kill-all") == 0;
  const int probe_mode = strcmp(argv[2], "--probe-ptrace") == 0;
  if ((kill_mode || probe_mode) && argc != 3) return EXIT_USAGE;
  /* /workspace is shared by every thread (D13): files are group-writable by default. */
  umask(S_IWOTH);
  const int switched = become(uid);
  if (switched != 0) return switched;
  if (kill_mode) return kill_all(uid);
  if (probe_mode) return probe_ptrace();
  const int limited = limit_processes();
  if (limited != 0) return limited;
  /* Only Pi's stdio and its policy socket (fd 3) go on; nothing else the agent might hold. */
  if (syscall(SYS_close_range, 4U, ~0U, 0U) != 0) {
    for (int fd = 4; fd < 1024; fd++) close(fd);
  }
  execvp(argv[2], argv + 2);
  return fail("exec");
}
