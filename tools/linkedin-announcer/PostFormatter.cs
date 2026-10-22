using System.Text;
using System.Text.RegularExpressions;

namespace LinkedInAnnouncer;

public static partial class PostFormatter
{
    private const int MaxLength = 2800;

    private static readonly string[] Hooks =
    [
        "The model is not the product — the contract around the model is.",
        "A 35B on a gaming GPU that finishes the agent loop — not a chatbot with tools bolted on.",
        "Local coding agent that reads → edits → tests → finishes. No Docker. No lock-in.",
        "Weak local models stop being a demo when the harness adapts.",
        "Open-source AI coding IDE: your models, your machine, an agent that actually closes the loop."
    ];

    public static string FormatReleasePost(string tagName, string releaseBody, string repoUrl, string? hook = null)
    {
        hook ??= Hooks[Math.Abs(tagName.GetHashCode(StringComparison.Ordinal)) % Hooks.Length];
        var baseUrl = repoUrl.TrimEnd('/');
        var notesUrl = $"{baseUrl}/releases/tag/{tagName}";
        var version = tagName.TrimStart('v', 'V');
        var setupAsset = $"CodeForge-Setup-{version}-win32-x64.exe";
        var downloadUrl = $"{baseUrl}/releases/download/{tagName}/{setupAsset}";
        var improvements = SummarizeImprovements(releaseBody);
        var hashtags = "#AI #OpenSource #LocalLLM #CodingAgent #DeveloperTools #llama.cpp";

        var sb = new StringBuilder();
        sb.AppendLine(hook);
        sb.AppendLine();
        sb.AppendLine($"CodeForge {tagName} is out.");
        sb.AppendLine();
        if (improvements.Count > 0)
        {
            sb.AppendLine("What's new:");
            foreach (var item in improvements)
                sb.AppendLine("• " + item);
        }
        else
        {
            sb.AppendLine("AI coding IDE on Code-OSS: adaptive harness, honest agent outcomes, Windows installer.");
        }

        sb.AppendLine();
        sb.AppendLine($"Repo: {baseUrl}");
        sb.AppendLine($"Download: {downloadUrl}");
        sb.AppendLine($"Release notes: {notesUrl}");
        sb.AppendLine();
        sb.Append(hashtags);

        var text = sb.ToString();
        if (text.Length <= MaxLength)
            return text;

        var footer = $"\n\nRepo: {baseUrl}\nDownload: {downloadUrl}\nRelease notes: {notesUrl}\n\n{hashtags}";
        var head = hook + $"\n\nCodeForge {tagName} is out.\n\nWhat's new:\n";
        var budget = MaxLength - head.Length - footer.Length - 1;
        var bullets = new StringBuilder();
        foreach (var item in improvements)
        {
            var line = "• " + item + "\n";
            if (bullets.Length + line.Length > budget)
                break;
            bullets.Append(line);
        }

        if (bullets.Length == 0)
        {
            return (hook
                    + $"\n\nCodeForge {tagName} is out.\n\nAI coding IDE on Code-OSS: adaptive harness, honest agent outcomes, Windows installer."
                    + footer)
                .TrimEnd();
        }

        return (head + bullets.ToString().TrimEnd() + footer).TrimEnd();
    }

    private static List<string> SummarizeImprovements(string releaseBody)
    {
        if (string.IsNullOrWhiteSpace(releaseBody))
            return [];

        var items = new List<string>();
        foreach (var raw in releaseBody.Replace("\r\n", "\n").Split('\n'))
        {
            var line = CleanMarkdownLine(raw.TrimEnd());
            if (string.IsNullOrWhiteSpace(line) || IsNoiseLine(line))
                continue;

            var text = line.TrimStart('•', '-', '*', ' ').Trim();
            if (string.IsNullOrWhiteSpace(text) || IsNoiseLine(text))
                continue;

            if (text.Length > 180)
                text = text[..177].TrimEnd() + "…";

            items.Add(text);
            if (items.Count >= 6)
                break;
        }

        return items;
    }

    private static bool IsNoiseLine(string line)
    {
        var lower = line.ToLowerInvariant().Trim();
        if (lower.Length == 0)
            return true;
        if (lower is "summary" or "what's new" or "whats new" or "what shipped" or "notes"
            or "release notes" or "install" or "fixes" or "changes")
            return true;
        if (lower.StartsWith("try it", StringComparison.Ordinal))
            return true;
        if (lower.StartsWith("repo:", StringComparison.Ordinal))
            return true;
        if (lower.StartsWith("download:", StringComparison.Ordinal))
            return true;
        if (lower.StartsWith("full notes", StringComparison.Ordinal))
            return true;
        if (lower.StartsWith("download **", StringComparison.Ordinal) || lower.StartsWith("download ", StringComparison.Ordinal))
            return true;
        if (lower.StartsWith("codeforge", StringComparison.Ordinal) && lower.Contains("is out", StringComparison.Ordinal))
            return true;
        if (lower.StartsWith("http://", StringComparison.Ordinal) || lower.StartsWith("https://", StringComparison.Ordinal))
            return true;
        return false;
    }

    private static string CleanMarkdownLine(string line)
    {
        line = HeadingRegex().Replace(line, "");
        line = LinkRegex().Replace(line, "$1");
        line = BoldRegex().Replace(line, "$1");
        line = InlineCodeRegex().Replace(line, "$1");
        if (line.StartsWith("- ", StringComparison.Ordinal) || line.StartsWith("* ", StringComparison.Ordinal))
            line = "• " + line[2..];
        return line.Trim();
    }

    [GeneratedRegex(@"^#{1,6}\s+")]
    private static partial Regex HeadingRegex();

    [GeneratedRegex(@"\[([^\]]+)\]\([^)]+\)")]
    private static partial Regex LinkRegex();

    [GeneratedRegex(@"\*\*([^*]+)\*\*")]
    private static partial Regex BoldRegex();

    [GeneratedRegex(@"`([^`]+)`")]
    private static partial Regex InlineCodeRegex();
}
