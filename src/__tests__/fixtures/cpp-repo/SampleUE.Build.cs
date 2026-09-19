using UnrealBuildTool;
public class SampleUE : ModuleRules {
    public SampleUE(ReadOnlyTargetRules Target) : base(Target) {
        // Both real-world array forms + the single-Add form (acceptance finding
        // 2026-07-10: real UE code uses the implicitly-typed `new[]`).
        PublicDependencyModuleNames.AddRange(new[] {
            "Core", "CoreUObject"
        });
        PrivateDependencyModuleNames.AddRange(new string[] { "Slate" });
        PrivateDependencyModuleNames.Add("UMG");
    }
}
