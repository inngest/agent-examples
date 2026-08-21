package bus

import "runtime"

// This file exists to anchor the runtime import used by the identity
// comparison helpers. Keeping it in its own file avoids a cycle with
// the reflection-based comparison path.
var _ = runtime.GOROOT
