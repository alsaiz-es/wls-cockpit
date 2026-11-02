// Main executable of WLS Cockpit.app. Notarization covers native code only, so a bundle whose
// entry point is a script would still be blocked by Gatekeeper; this launcher replaces itself
// with the bundled Node runtime running the Cockpit CLI on the portable port. If Cockpit already
// listens there, the CLI opens the browser on it and exits.
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  char executable[PATH_MAX];
  uint32_t size = sizeof executable;
  char resolved[PATH_MAX];
  if (_NSGetExecutablePath(executable, &size) != 0 || realpath(executable, resolved) == NULL) {
    fprintf(stderr, "WLS Cockpit: cannot locate the application bundle.\n");
    return 1;
  }

  // resolved = <bundle>/Contents/MacOS/WLS Cockpit
  char *slash = strrchr(resolved, '/');
  if (slash == NULL) return 1;
  *slash = '\0';

  char node[PATH_MAX];
  char cli[PATH_MAX];
  snprintf(node, sizeof node, "%s/node", resolved);
  snprintf(cli, sizeof cli, "%s/../Resources/dist-server/wls-cockpit.mjs", resolved);

  char *const args[] = {node, cli, "--port=8888", "--open", NULL};
  execv(node, args);
  perror("WLS Cockpit: cannot start the bundled Node runtime");
  return 1;
}
