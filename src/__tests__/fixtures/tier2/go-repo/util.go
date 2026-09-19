package probe

func helper() {}

func crossFileOnly() {
	// Run is defined in main.go — tier-2 must NOT resolve this (same-file only).
	otherRun()
}

func otherRun() {}
