package probe

import (
	"fmt"
)

type Engine struct{}

func (e Engine) Run() {
	helper()
	fmt.Println("x")
}

func main() {
	helper()
}
