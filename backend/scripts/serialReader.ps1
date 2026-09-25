param(
    [string]$PortName = 'COM3',
    [int]$BaudRate = 115200
)

$port = New-Object System.IO.Ports.SerialPort $PortName, $BaudRate, 'None', 8, 'One'
$port.ReadTimeout = 3000
$port.WriteTimeout = 3000
$port.DtrEnable = $false
$port.RtsEnable = $false

try {
    $port.Open()
    [Console]::Out.WriteLine("[BRIDGE_OPEN_SUCCESS]")
    [Console]::Out.Flush()
} catch {
    [Console]::Error.WriteLine("Cannot open $PortName : $_")
    exit 1
}

try {
    while ($true) {
        try {
            $line = $port.ReadLine()
            if ($line) {
                [Console]::Out.WriteLine($line)
                [Console]::Out.Flush()
            }
        } catch [System.TimeoutException] {
            # Normal when port is idle
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }
} finally {
    if ($port.IsOpen) {
        $port.Close()
    }
}
