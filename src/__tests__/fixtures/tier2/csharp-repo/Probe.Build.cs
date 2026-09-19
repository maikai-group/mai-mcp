// UE build-script decoy: tier2-csharp must emit ZERO nodes for this file
// (ue-module owns *.Build.cs). If a `file` node for this path appears, the
// basename skip regressed.
public class ProbeBuildRules {
    public void ConfigureBuild() {}
}
