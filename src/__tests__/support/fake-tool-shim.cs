// SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
// Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely.
//
// Test-only Windows shim, compiled on the host by fake-tool.ts through
// Windows PowerShell's built-in C# compiler (Add-Type -OutputAssembly), so
// no binary is ever committed. Windows cannot execute a shell script and Node
// refuses .cmd files without a shell, so every fake tool the suites install
// (git, npm, claude, codex, launchctl, schtasks, lsof …) becomes a copy of
// this executable beside two sidecars:
//   <self>.runner  line 1: interpreter (bash.exe or node.exe), line 2: script
// The shim relaunches `interpreter script args…` with the exact argv it was
// given (MSVCRT quoting rules, so the child parses the same strings), inherited
// stdio, and a job object that ends the whole subtree when the shim dies —
// the behaviour a real single-process tool has when the product kills it.
// The SHIM joins that job before it starts the child, so the child is born
// inside it and no descendant can be spawned in the gap between start and
// assignment (finding 912734e9). Every Win32 result that decides behaviour is
// checked, and its error is read into a local BEFORE anything touches
// Console.Error — console initialisation runs its own SetLastError P/Invokes
// and would overwrite the code being reported. When the job is unavailable the
// shim says so on stderr and the tree leaks visibly, rather than degrading to a
// leak that reads as a flaky test.
// C# 5 only: Windows PowerShell 5.1 compiles with the .NET Framework compiler.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class MaiFakeToolShim
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    struct JobBasicLimit
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobExtendedLimit
    {
        public JobBasicLimit BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    // Windows command-line quoting as the C runtime parses it: backslashes are
    // literal unless they precede a double quote, where they double.
    static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return argument;
        StringBuilder quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in argument)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append(c);
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(c);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    static void Warn(string message)
    {
        Console.Error.WriteLine("fake tool shim: " + message + "; the child tree will not be reaped");
    }

    static IntPtr KillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            int createError = Marshal.GetLastWin32Error();
            Warn("CreateJobObject failed (error " + createError + ")");
            return IntPtr.Zero;
        }
        JobExtendedLimit limit = new JobExtendedLimit();
        limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JobExtendedLimit));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        bool limited;
        int error = 0;
        try
        {
            Marshal.StructureToPtr(limit, buffer, false);
            limited = SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size);
            if (!limited) error = Marshal.GetLastWin32Error();
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        if (!limited)
        {
            // A job that cannot kill on close buys nothing; say so and drop it.
            Warn("SetInformationJobObject(kill-on-close) failed (error " + error + ")");
            // Nothing is assigned yet and no limit was set, so this handle's
            // fate decides nothing; the result is deliberately not reported.
            CloseHandle(job);
            return IntPtr.Zero;
        }
        return job;
    }

    public static int Main(string[] args)
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string[] runner = File.ReadAllLines(self + ".runner");
        if (runner.Length < 2)
        {
            Console.Error.WriteLine("fake tool shim: " + self + ".runner must name an interpreter and a script");
            return 125;
        }
        StringBuilder arguments = new StringBuilder(Quote(runner[1]));
        foreach (string argument in args)
        {
            arguments.Append(' ');
            arguments.Append(Quote(argument));
        }
        ProcessStartInfo start = new ProcessStartInfo(runner[0], arguments.ToString());
        start.UseShellExecute = false;
        // Git Bash must not rewrite arguments such as /Query into Windows paths.
        start.EnvironmentVariables["MSYS_NO_PATHCONV"] = "1";
        start.EnvironmentVariables["MSYS2_ARG_CONV_EXCL"] = "*";
        IntPtr job = KillOnCloseJob();
        // Join the job BEFORE the child exists: a child is associated with its
        // parent's job at creation and Process.Start requests no breakaway, so
        // there is no unsupervised window. Assigning an already-jobbed process
        // nests the job (Windows 8+). If that is refused, assigning the child
        // after start is attempted but almost always refused too — the outer
        // job it inherited is the same one that refused us — and it only
        // succeeds, reinstating the original race, when that outer job carries
        // SILENT_BREAKAWAY_OK and the child is born jobless. Either way the
        // shim says so rather than leaking quietly.
        bool joined = false;
        if (job != IntPtr.Zero)
        {
            joined = AssignProcessToJobObject(job, GetCurrentProcess());
            if (!joined)
            {
                int selfError = Marshal.GetLastWin32Error();
                Console.Error.WriteLine("fake tool shim: AssignProcessToJobObject(self) failed (error " +
                    selfError + "); assigning the child after start instead");
            }
        }
        Process child = Process.Start(start);
        if (job != IntPtr.Zero && !joined)
        {
            bool assigned = AssignProcessToJobObject(job, child.Handle);
            int childError = Marshal.GetLastWin32Error();
            if (!assigned) Warn("AssignProcessToJobObject(child) failed (error " + childError + ")");
        }
        child.WaitForExit();
        return child.ExitCode;
    }
}
