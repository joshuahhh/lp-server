#!/bin/bash

cp lp-server.service /lib/systemd/system/
systemctl stop lp-server
sudo systemctl daemon-reload
systemctl start lp-server
systemctl enable lp-server
