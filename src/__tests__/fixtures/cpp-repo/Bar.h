#pragma once
namespace App {
class Helper {
public:
    void Run();
};
void Helper();
class ABaseThing {};

// UE DLL-export macro between `class` and the name (real-world pattern).
class GAMEUE_API FExported : public ABaseThing {
public:
    void Pump();
};
}
