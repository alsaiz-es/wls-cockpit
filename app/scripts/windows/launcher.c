// WLS Cockpit.exe, the double-click entry point of the Windows portable. A batch file cannot carry
// an icon and keeps a console window open; this launcher starts the bundled Node runtime on the
// Cockpit CLI without a console (port 8888, browser opened) and exits; Cockpit stops with Quit or
// when its last browser tab closes. If Cockpit already listens there, the CLI opens the browser on
// it and exits.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>

#define PATH_CHARS 4096

static int fail(const wchar_t *message) {
  MessageBoxW(NULL, message, L"WLS Cockpit", MB_OK | MB_ICONERROR);
  return 1;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR arguments, int show) {
  (void)instance;
  (void)previous;
  (void)arguments;
  (void)show;

  wchar_t folder[PATH_CHARS];
  DWORD length = GetModuleFileNameW(NULL, folder, PATH_CHARS);
  if (length == 0 || length >= PATH_CHARS) return fail(L"Cannot locate the WLS Cockpit folder.");
  wchar_t *slash = wcsrchr(folder, L'\\');
  if (slash == NULL) return fail(L"Cannot locate the WLS Cockpit folder.");
  *slash = L'\0';

  wchar_t node[PATH_CHARS];
  _snwprintf(node, PATH_CHARS, L"%ls\\node\\node.exe", folder);
  if (GetFileAttributesW(node) == INVALID_FILE_ATTRIBUTES) {
    _snwprintf(node, PATH_CHARS, L"%ls\\node.exe", folder);
    if (GetFileAttributesW(node) == INVALID_FILE_ATTRIBUTES) {
      return fail(L"The Node runtime is missing from this folder (node\\node.exe). Download the portable archive again.");
    }
  }

  wchar_t command[PATH_CHARS * 2];
  _snwprintf(command, PATH_CHARS * 2, L"\"%ls\" \"%ls\\dist-server\\wls-cockpit.mjs\" --host=127.0.0.1 --port=8888 --open --exit-with-last-tab",
             node, folder);

  STARTUPINFOW startup = {0};
  startup.cb = sizeof startup;
  PROCESS_INFORMATION process = {0};
  if (!CreateProcessW(node, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, folder, &startup, &process)) {
    return fail(L"Cannot start the bundled Node runtime.");
  }

  // Without a console a start-up failure would be invisible: report an early non-zero exit.
  if (WaitForSingleObject(process.hProcess, 5000) == WAIT_OBJECT_0) {
    DWORD exitCode = 0;
    GetExitCodeProcess(process.hProcess, &exitCode);
    if (exitCode != 0) {
      wchar_t message[512];
      _snwprintf(message, 512,
                 L"WLS Cockpit stopped with exit code %lu, for example because another program uses port 8888.\n\n"
                 L"Run start-wls-cockpit.cmd in this folder to see the reason.",
                 exitCode);
      CloseHandle(process.hThread);
      CloseHandle(process.hProcess);
      return fail(message);
    }
  }
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return 0;
}
