// Windows x64: g++ -std=c++17 -Os -s -static -municode audio-mute.cpp -o audio-mute.exe -lole32 -luuid
#include <windows.h>
#include <tlhelp32.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <wrl/client.h>
#include <string>
#include <unordered_map>

using Microsoft::WRL::ComPtr;

static bool belongsToService(DWORD pid, DWORD service, const std::wstring& directory) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return false;
    wchar_t image[32768];
    DWORD length = ARRAYSIZE(image);
    BOOL resolved = QueryFullProcessImageNameW(process, 0, image, &length);
    CloseHandle(process);
    if (!resolved) return false;
    std::wstring path(image, length);
    auto split = path.find_last_of(L'\\');
    if (split == path.npos || _wcsicmp(path.substr(0, split).c_str(), directory.c_str())) return false;

    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return false;
    PROCESSENTRY32W entry = {};
    entry.dwSize = sizeof(entry);
    std::unordered_map<DWORD, DWORD> parents;
    if (Process32FirstW(snapshot, &entry)) {
        do { parents.emplace(entry.th32ProcessID, entry.th32ParentProcessID); }
        while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    while (pid != service) {
        auto found = parents.find(pid);
        if (found == parents.end()) return false;
        pid = found->second;
        parents.erase(found);
    }
    return true;
}

static void muteSessions(IMMDevice* device, DWORD service, const std::wstring& directory) {
    ComPtr<IAudioSessionManager2> manager;
    if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                                reinterpret_cast<void**>(manager.GetAddressOf())))) return;
    ComPtr<IAudioSessionEnumerator> sessions;
    if (FAILED(manager->GetSessionEnumerator(&sessions))) return;
    int count = 0;
    sessions->GetCount(&count);
    for (int index = 0; index < count; ++index) {
        ComPtr<IAudioSessionControl> session;
        ComPtr<IAudioSessionControl2> info;
        ComPtr<ISimpleAudioVolume> volume;
        DWORD pid = 0;
        BOOL muted = FALSE;
        if (SUCCEEDED(sessions->GetSession(index, &session)) && SUCCEEDED(session.As(&info))
            && info->GetProcessId(&pid) == S_OK && pid && SUCCEEDED(session.As(&volume))
            && SUCCEEDED(volume->GetMute(&muted)) && !muted && belongsToService(pid, service, directory))
            volume->SetMute(TRUE, nullptr);
    }
}

int wmain(int argc, wchar_t** argv) {
    if (argc != 3) return 1;
    DWORD service = wcstoul(argv[1], nullptr, 10);
    HANDLE owner = OpenProcess(SYNCHRONIZE, FALSE, service);
    if (!owner || FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 1;
    ComPtr<IMMDeviceEnumerator> devices;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                IID_PPV_ARGS(&devices)))) return 1;
    do {
        ComPtr<IMMDeviceCollection> outputs;
        UINT count = 0;
        if (SUCCEEDED(devices->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &outputs)))
            outputs->GetCount(&count);
        for (UINT index = 0; index < count; ++index) {
            ComPtr<IMMDevice> device;
            if (SUCCEEDED(outputs->Item(index, &device))) muteSessions(device.Get(), service, argv[2]);
        }
    } while (WaitForSingleObject(owner, 100) == WAIT_TIMEOUT);
    devices.Reset();
    CoUninitialize();
    CloseHandle(owner);
    return 0;
}
