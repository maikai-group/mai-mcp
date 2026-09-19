#pragma once

class MacroPanelA {
public:
    void pump();
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MacroPanelA)
};

class MacroPanelB {
public:
    void go();
    JUCE_LEAK_DETECTOR(MacroPanelB)
};
