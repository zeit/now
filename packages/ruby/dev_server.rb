require 'socket'
require 'webrick'

# Get an available port
port = Addrinfo.tcp("", 0).bind { |s| s.local_address.ip_port }
host = "0.0.0.0"

server = WEBrick::HTTPServer.new(
  BindAddress: host,
  Port: port,
  Logger: WEBrick::Log.new(File.open(File::NULL, 'w'))
)

STDOUT.sync = true
STDOUT.write "RUBY_DEV_SERVER_PORT=#{port}"
STDOUT.flush
# File.write(ENV['VERCEL_DEV_PORT_FILE'], port.to_s)

load_err = nil
begin
  require ENV['VERCEL_DEV_HANDLER_FILE']

  if not Object.const_defined?('Handler')
    load_err = Error.new('Handler not defined in lambda')
  end
rescue => err
  load_err = err
end

handler =
  if load_err
    Proc.new do |req, res|
      STDERR.puts "Caught error during handler file initialization: #{load_err.message}"
      STDERR.puts load_err.backtrace.join("\n")

      res.status = 500
      res['Content-Type'] = 'application/json; charset=utf-8'
      res.body = { error: load_err.message }.to_json
    end
  else
    Handler
  end

if handler.is_a?(Proc)
  server.mount_proc '/', handler
else
  server.mount '/', handler
end

server.start
