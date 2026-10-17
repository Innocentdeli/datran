cmake_minimum_required(VERSION 3.16)
project(datran_client VERSION 0.1.0 LANGUAGES CXX)

# Header-only library target.
add_library(datran_client INTERFACE)
add_library(datran::client ALIAS datran_client)
target_include_directories(datran_client INTERFACE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>)
target_compile_features(datran_client INTERFACE cxx_std_17)
if(WIN32)
    target_link_libraries(datran_client INTERFACE ws2_32)
endif()

option(DATRAN_BUILD_TESTS "Build the datran client test executable" ${PROJECT_IS_TOP_LEVEL})
if(DATRAN_BUILD_TESTS)
    enable_testing()
    add_executable(datran_client_test test/client_test.cpp)
    target_link_libraries(datran_client_test PRIVATE datran::client)
    target_compile_definitions(datran_client_test PRIVATE DATRAN_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}")
    if(MSVC)
        target_compile_options(datran_client_test PRIVATE /W4)
    else()
        target_compile_options(datran_client_test PRIVATE -Wall -Wextra -Wpedantic)
    endif()
    if(MINGW)
        # Standalone test binary (no libstdc++/winpthread DLLs needed on PATH).
        target_link_options(datran_client_test PRIVATE -static)
    endif()
    add_test(NAME datran_client_test COMMAND datran_client_test)
endif()

install(DIRECTORY include/ DESTINATION include)
