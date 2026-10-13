// A stand-in for the todos command-line client. It exists so the app build can
// be tested: `npm run dist` bundles whatever cli/build.sh produces, and this is
// something for it to produce when the real client (in cli/) isn't there.
package main

import "fmt"

func main() {
	fmt.Println("todos stand-in: this is not the real command-line client")
}
