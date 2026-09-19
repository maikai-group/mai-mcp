#pragma once
#include "Bar.h"

namespace App {

UCLASS()
class AMyActor : public AActor, public ABaseThing {
public:
    UFUNCTION(BlueprintCallable)
    void Tick(float dt);

    void Tick(float dt, int extra);   // overload

    int Count() const { return n; }
private:
    UPROPERTY()
    int n;
};

class WidgetHost {
public:
    WidgetHost* sibling();
    const WidgetHost& self() const;
};

WidgetHost* makeHost();

}
