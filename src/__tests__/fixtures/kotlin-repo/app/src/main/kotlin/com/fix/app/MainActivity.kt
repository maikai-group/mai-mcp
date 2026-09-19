package com.fix.app

import com.fix.core.Loader
import com.fix.core.Dup
import com.fix.core.lookup
import androidx.compose.runtime.Composable

class FixApp

class MainActivity : ComponentActivity(), Refreshable {
    fun boot() {
        Loader.warm()
        render()
    }
}

@Composable
fun StatusRow(m: MainActivity) {
    m.boot()
}

fun render() {
    lookup()
}
