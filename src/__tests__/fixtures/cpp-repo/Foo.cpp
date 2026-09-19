#include "Foo.h"
#include "Bar.h"

void App::AMyActor::Tick(float dt) {
    Helper();
    Count();
}

void App::AMyActor::Tick(float dt, int extra) {
    Tick(dt);
}

App::WidgetHost* App::WidgetHost::sibling() { return this; }
App::WidgetHost* App::makeHost() { return nullptr; }
