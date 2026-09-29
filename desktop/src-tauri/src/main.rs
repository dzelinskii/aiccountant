// без консольного окна в сборке для человека; в отладке консоль нужна
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aiccountant_desktop_lib::run()
}
